# Third-Party Licenses

WattSnatch is licensed under the PolyForm Noncommercial License 1.0.0 (see
`LICENSE`). This file lists third-party code whose logic or protocol
knowledge was adapted (not copy-pasted - EVCC is written in Go, WattSnatch in
JavaScript) into WattSnatch, along with the required attribution for each.

## andrewcourtice/ripl

<https://github.com/andrewcourtice/ripl> (<https://www.ripl.run>) - MIT License.

```
MIT License

Copyright (c) 2022 Andrew Courtice

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Used for: `public/vendor/ripl/ripl.bundle.js`, a bundled build of
`@ripl/charts` (bar and heatmap charts) and its `@ripl/core`, `@ripl/canvas`,
`@ripl/dom`, `@ripl/web`, `@ripl/utilities` dependencies, used for every
chart on the Data page (Daily Energy Flow, Daily Performance Heatmap, Daily
Energy Shape, Time-of-Day Pattern, Savings vs Spend). Bundled with esbuild
from the published npm packages, unmodified - see
`public/vendor/ripl/LICENSE.txt` for the copy distributed alongside the
bundle itself.

## evcc-io/evcc

<https://github.com/evcc-io/evcc> - MIT License.

```
MIT License

Copyright (c) evcc.io (andig, naltatis, premultiply)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Used for: the Modbus TCP register addresses (and, for Sungrow, the EMS-mode
charge-control write sequence) in `src/services/battery/sigenergy.js` and
`src/services/battery/sungrow.js`, taken from EVCC's
`templates/definition/meter/sigenergy.yaml` and `sungrow-hybrid.yaml`.

## andig/go-powerwall

<https://github.com/andig/go-powerwall> - MIT License (the library evcc-io/evcc
itself depends on for Tesla Powerwall support).

```
MIT License

Copyright 2021 Alex Stewart

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Used for: the local Tesla Energy Gateway login flow (`/api/login/Basic`,
`AuthCookie` cookie, self-signed-cert/SNI handling) and endpoint shapes
(`/api/meters/aggregates`, `/api/system_status/soe`, `/api/system_status`) in
`src/services/battery/teslaPowerwall.js`.

Neither dependency's code is vendored or executed by WattSnatch - only the
protocol knowledge (register addresses, endpoint paths, request/response
shapes) was read from their public source and reimplemented in JavaScript
against WattSnatch's own provider contract.
