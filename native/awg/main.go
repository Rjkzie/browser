package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"
)

type dialer interface {
	DialContext(context.Context, string, string) (net.Conn, error)
}
type wgConfig struct {
	addresses, dns []netip.Addr
	mtu            int
	ipc            string
}

func parseConfig(text string) (wgConfig, error) {
	c := wgConfig{mtu: 1280}
	section := ""
	peers := 0
	fields := map[string]map[string]string{"interface": {}, "peer": {}}
	scan := bufio.NewScanner(strings.NewReader(text))
	for scan.Scan() {
		line := strings.TrimSpace(strings.SplitN(scan.Text(), "#", 2)[0])
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			section = strings.ToLower(strings.Trim(line, "[] "))
			if section == "peer" {
				peers++
			}
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if len(kv) != 2 || fields[section] == nil {
			return c, errors.New("invalid configuration")
		}
		fields[section][strings.ToLower(strings.TrimSpace(kv[0]))] = strings.TrimSpace(kv[1])
	}
	if peers != 1 {
		return c, errors.New("one peer required")
	}
	decodeKey := func(s string) (string, error) {
		b, e := base64.StdEncoding.DecodeString(s)
		if e != nil || len(b) != 32 {
			return "", errors.New("invalid key")
		}
		return hex.EncodeToString(b), nil
	}
	i, p := fields["interface"], fields["peer"]
	private, e := decodeKey(i["privatekey"])
	if e != nil {
		return c, e
	}
	public, e := decodeKey(p["publickey"])
	if e != nil {
		return c, e
	}
	for _, v := range strings.Split(i["address"], ",") {
		v = strings.TrimSpace(v)
		prefix, e := netip.ParsePrefix(v)
		if e != nil {
			return c, errors.New("invalid interface address")
		}
		c.addresses = append(c.addresses, prefix.Addr())
	}
	for _, v := range strings.Split(i["dns"], ",") {
		ip, e := netip.ParseAddr(strings.TrimSpace(v))
		if e != nil {
			return c, errors.New("DNS IP required")
		}
		c.dns = append(c.dns, ip)
	}
	endpoint, e := net.ResolveUDPAddr("udp", p["endpoint"])
	if e != nil || endpoint.Port == 0 {
		return c, errors.New("invalid endpoint")
	}
	c.ipc = "private_key=" + private + "\n"
	for _, key := range []string{"jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5"} {
		if value := i[key]; value != "" {
			if strings.ContainsAny(value, "\r\n") {
				return c, errors.New("invalid parameter")
			}
			c.ipc += key + "=" + value + "\n"
		}
	}
	c.ipc += "replace_peers=true\npublic_key=" + public + "\nendpoint=" + endpoint.String() + "\nreplace_allowed_ips=true\nallowed_ip=0.0.0.0/0\nallowed_ip=::/0\n"
	if p["presharedkey"] != "" {
		key, e := decodeKey(p["presharedkey"])
		if e != nil {
			return c, e
		}
		c.ipc += "preshared_key=" + key + "\n"
	}
	if p["persistentkeepalive"] != "" {
		v, e := strconv.Atoi(p["persistentkeepalive"])
		if e != nil || v < 0 || v > 65535 {
			return c, errors.New("invalid keepalive")
		}
		c.ipc += "persistent_keepalive_interval=" + strconv.Itoa(v) + "\n"
	}
	if i["mtu"] != "" {
		v, e := strconv.Atoi(i["mtu"])
		if e != nil || v < 576 || v > 9000 {
			return c, errors.New("invalid MTU")
		}
		c.mtu = v
	}
	return c, scan.Err()
}

func serveSOCKS(client net.Conn, network dialer) {
	defer client.Close()
	client.SetDeadline(time.Now().Add(15 * time.Second))
	read := func(n int) ([]byte, error) { b := make([]byte, n); _, e := io.ReadFull(client, b); return b, e }
	header, e := read(2)
	if e != nil || header[0] != 5 || header[1] == 0 {
		return
	}
	methods, e := read(int(header[1]))
	if e != nil {
		return
	}
	allowed := false
	for _, m := range methods {
		if m == 0 {
			allowed = true
		}
	}
	if !allowed {
		client.Write([]byte{5, 255})
		return
	}
	client.Write([]byte{5, 0})
	req, e := read(4)
	if e != nil || req[0] != 5 || req[1] != 1 || req[2] != 0 {
		client.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	var host string
	switch req[3] {
	case 1:
		b, e := read(4)
		if e != nil {
			return
		}
		host = net.IP(b).String()
	case 4:
		b, e := read(16)
		if e != nil {
			return
		}
		host = net.IP(b).String()
	case 3:
		b, e := read(1)
		if e != nil || b[0] == 0 {
			return
		}
		b, e = read(int(b[0]))
		if e != nil {
			return
		}
		host = string(b)
	default:
		return
	}
	port, e := read(2)
	if e != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	remote, e := network.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port)))))
	if e != nil {
		client.Write([]byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer remote.Close()
	client.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	client.SetDeadline(time.Time{})
	done := make(chan struct{}, 1)
	go func() {
		io.Copy(remote, client)
		if tcp, ok := remote.(interface{ CloseWrite() error }); ok {
			tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	io.Copy(client, remote)
	client.Close()
	<-done
}

func run() error {
	var request struct {
		Config string `json:"config"`
	}
	reader := bufio.NewReader(io.LimitReader(os.Stdin, 2*1024*1024))
	line, e := reader.ReadBytes('\n')
	if e != nil {
		return e
	}
	if e = json.Unmarshal(line, &request); e != nil {
		return errors.New("invalid input")
	}
	config, e := parseConfig(request.Config)
	if e != nil {
		return e
	}
	tun, network, e := netstack.CreateNetTUN(config.addresses, config.dns, config.mtu)
	if e != nil {
		return errors.New("netstack failed")
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	defer dev.Close()
	if e = dev.IpcSet(config.ipc); e != nil {
		return errors.New("invalid WireGuard/AmneziaWG parameters")
	}
	if e = dev.Up(); e != nil {
		return errors.New("tunnel startup failed")
	}
	listener, e := net.Listen("tcp", "127.0.0.1:19081")
	if e != nil {
		return errors.New("proxy port unavailable")
	}
	defer listener.Close()
	fmt.Println("READY")
	go func() { io.Copy(io.Discard, reader); listener.Close() }()
	limit := make(chan struct{}, 128)
	for {
		client, e := listener.Accept()
		if e != nil {
			return nil
		}
		select {
		case limit <- struct{}{}:
			go func() { defer func() { <-limit }(); serveSOCKS(client, network) }()
		default:
			client.Close()
		}
	}
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e.Error())
		os.Exit(1)
	}
}
