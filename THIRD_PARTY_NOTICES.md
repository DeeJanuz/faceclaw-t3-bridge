# Third-party notices

Original code in this repository is MIT licensed. Dependencies and assets keep their own licenses; the project license does not replace them.

| Component | License | Notice |
| --- | --- | --- |
| Even Hub SDK 0.0.14 | MIT | [Bundled license](public/licenses/EVEN-HUB-SDK-MIT.txt) |
| @evenrealities/pretext 0.1.4 | MIT (published package metadata) | [Package notice](public/licenses/PRETEXT-MIT.txt) |
| Doto typeface | SIL Open Font License 1.1 | [Font license](public/dashboard/FONT-LICENSE.txt) |
| Tabler icons | MIT | [Icon license](public/dashboard/ICONS-LICENSE.txt) |
| ws (computer bridge) | MIT | License installed with the locked npm dependency |

The license files under `public/` are included in generated `.ehpk` archives. Node.js, T3 Code, Tailscale, whisper.cpp, and Whisper model weights are installed separately and retain their upstream licenses. This repository does not redistribute those executables or model weights. Development tools installed through npm retain their package licenses.

Weather and city data come from Open-Meteo and GeoNames. The default weather integration uses Open-Meteo's noncommercial service; that service's terms apply independently of this source code's MIT license. See [Open-Meteo terms](https://open-meteo.com/en/terms).
