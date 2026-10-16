# Third-party components

Quiet Browser is an independent project. Product names identify upstream compatibility, not endorsement.

| Component | Source / corresponding source | License |
| --- | --- | --- |
| Electron / Chromium | https://github.com/electron/electron | MIT and Chromium third-party licenses; included in Electron distribution |
| Xray-core | https://github.com/XTLS/Xray-core | MPL-2.0; upstream LICENSE shipped with the bundle |
| AmneziaWG Go | https://github.com/amnezia-vpn/amneziawg-go | MIT; locked version in native/awg/go.mod |
| gVisor | https://github.com/google/gvisor | Apache-2.0; Go module sources in dependency cache / upstream |
| uBlock Origin | https://github.com/gorhill/uBlock | GPL-3.0-or-later; complete unpacked extension JavaScript and license shipped |
| zapret strategies | https://github.com/Flowseal/zapret-discord-youtube | MIT; LICENSE.txt shipped |
| zapret / winws | https://github.com/bol-van/zapret | MIT; upstream bundle and source references |
| WinDivert | https://github.com/basil00/WinDivert | LGPL-3.0 / WinDivert license; upstream license shipped where supplied |
| Tor Expert Bundle | https://gitlab.torproject.org/tpo/core/tor and https://dist.torproject.org/torbrowser/ | BSD-style and bundled dependency licenses in docs/ |

The upstream uBlock JavaScript is unchanged. Quiet Browser adds `quiet-compat.js` and a script reference in `background.html`; the adapter source is in `src/ublock-compat.js`. This modified extension bundle retains the upstream GPL license and complete JavaScript source. No attempt is made to relicense upstream work under MIT.

Native Go dependencies and exact versions are listed in `native/awg/go.mod` and `go.sum`. Build tooling copies their license notices into the packaged AmneziaWG folder. No Happ installer or proprietary Happ application is distributed; compatibility uses the independent Xray-core.
