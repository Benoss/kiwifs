# Third-party notices

KiwiFS is licensed under the Business Source License 1.1 (see `LICENSE`). The
binary also contains the third-party software below, used unmodified under its
own license. Each license text ships with the module's source at the URL given.

## D2 diagram renderer

Linked into `internal/d2render` and left out of builds made with `-tags nod2`.

| Component | License | Source |
|---|---|---|
| D2 (`github.com/d2lang/d2`) | Mozilla Public License 2.0 | https://github.com/terrastruct/d2 |
| elk-go (`github.com/d2lang/elk-go`) | Eclipse Public License 2.0 | https://github.com/d2lang/elk-go |
| dagro (`github.com/d2lang/dagro`) | MIT | https://github.com/d2lang/dagro |
| rough-go (`github.com/d2lang/rough-go`) | MIT | https://github.com/d2lang/rough-go |
| mathjax-go (`github.com/d2lang/mathjax-go`) | Apache License 2.0 | https://github.com/d2lang/mathjax-go |
| util-go (`github.com/d2lang/util-go`) | ISC-style (Terrastruct) | https://github.com/d2lang/util-go |
| go-text/typesetting | Unlicense or BSD-3-Clause | https://github.com/go-text/typesetting |
| chroma | MIT | https://github.com/alecthomas/chroma |
| goquery | BSD-3-Clause | https://github.com/PuerkitoBio/goquery |
| regexp2 | MIT | https://github.com/dlclark/regexp2 |
| go-colorful | MIT | https://github.com/lucasb-eyer/go-colorful |
| csscolorparser | MIT | https://github.com/mazznoer/csscolorparser |
| uniseg | MIT | https://github.com/rivo/uniseg |

The MPL-2.0 and EPL-2.0 components are distributed in object form inside the
KiwiFS binary; their complete corresponding source is available at the URLs
above, at the versions pinned in `go.mod`.

### Fonts embedded by D2

Source Sans Pro, Source Code Pro, Fuzzy Bubbles and Noto Color Emoji (v2.051)
are licensed under the SIL Open Font License 1.1
(https://openfontlicense.org). Diagrams rendered with them are not subject to
the font license.
