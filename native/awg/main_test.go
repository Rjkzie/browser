package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"
)

func testKey(t *testing.T) (*ecdh.PrivateKey, string) {
	t.Helper()
	k, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	return k, base64.StdEncoding.EncodeToString(k.Bytes())
}
func TestParseConfiguration(t *testing.T) {
	key, private := testKey(t)
	public := base64.StdEncoding.EncodeToString(key.PublicKey().Bytes())
	text := fmt.Sprintf("[Interface]\nPrivateKey=%s\nAddress=10.77.0.2/32\nDNS=10.77.0.1\nJc=3\n[Peer]\nPublicKey=%s\nEndpoint=127.0.0.1:12345\nAllowedIPs=0.0.0.0/0", private, public)
	c, e := parseConfig(text)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(c.ipc, "jc=3\n") || len(c.addresses) != 1 {
		t.Fatal("configuration lost")
	}
	if _, e := parseConfig(text + "\n[Peer]\nPublicKey=bad"); e == nil {
		t.Fatal("multiple peers accepted")
	}
}
func TestUserspaceTunnel(t *testing.T) {
	for _, obfuscation := range []string{"", "jc=3\njmin=10\njmax=40\ns1=0\ns2=0\nh1=123456\nh2=234567\nh3=345678\nh4=456789\n"} {
		name := "WireGuard"
		if obfuscation != "" {
			name = "AmneziaWG"
		}
		t.Run(name, func(t *testing.T) {
			left, _ := testKey(t)
			right, _ := testKey(t)
			socket, e := net.ListenPacket("udp", "127.0.0.1:0")
			if e != nil {
				t.Fatal(e)
			}
			port := socket.LocalAddr().(*net.UDPAddr).Port
			socket.Close()
			makeDevice := func(ip string) (*device.Device, *netstack.Net) {
				tun, n, e := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr(ip)}, []netip.Addr{netip.MustParseAddr("10.77.0.1")}, 1280)
				if e != nil {
					t.Fatal(e)
				}
				d := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
				t.Cleanup(d.Close)
				return d, n
			}
			server, serverNet := makeDevice("10.77.0.1")
			client, clientNet := makeDevice("10.77.0.2")
			if e := server.IpcSet("private_key=" + hex.EncodeToString(right.Bytes()) + "\nlisten_port=" + fmt.Sprint(port) + "\n" + obfuscation + "public_key=" + hex.EncodeToString(left.PublicKey().Bytes()) + "\nallowed_ip=10.77.0.2/32\n"); e != nil {
				t.Fatal(e)
			}
			if e := client.IpcSet("private_key=" + hex.EncodeToString(left.Bytes()) + "\n" + obfuscation + "public_key=" + hex.EncodeToString(right.PublicKey().Bytes()) + "\nendpoint=127.0.0.1:" + fmt.Sprint(port) + "\nallowed_ip=10.77.0.1/32\n"); e != nil {
				t.Fatal(e)
			}
			if e := server.Up(); e != nil {
				t.Fatal(e)
			}
			if e := client.Up(); e != nil {
				t.Fatal(e)
			}
			listener, e := serverNet.ListenTCPAddrPort(netip.MustParseAddrPort("10.77.0.1:8080"))
			if e != nil {
				t.Fatal(e)
			}
			defer listener.Close()
			go func() {
				c, e := listener.Accept()
				if e == nil {
					defer c.Close()
					io.Copy(c, c)
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			c, e := clientNet.DialContext(ctx, "tcp", "10.77.0.1:8080")
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(10 * time.Second))
			c.Write([]byte("private browser"))
			b := make([]byte, 15)
			if _, e := io.ReadFull(c, b); e != nil {
				t.Fatal(e)
			}
			if string(b) != "private browser" {
				t.Fatal("payload mismatch")
			}
		})
	}
}
