# color-cube

Interactive 3D tool for seeing how the edges of a CIELAB code range (L* 0–100, a*/b* ±128·k) line up with the sRGB, Display P3 and Adobe RGB (1998) gamuts.

**Live:** https://kylemcdonald.github.io/color-cube/

- Each space is drawn as a 12-edge cube. The edge casing color identifies the space, and the core shows the true color along that edge.
- View in CIELAB, box-normalized CIELAB, OKLab, XYZ, or any encoded or linear RGB space.
- Optional faces, L* and hue slice planes, and boundary contours, with out-of-gamut regions hatched, greyed or cut away.
- 2D a*b* and constant-hue slices, plus a hover readout of 8-bit code values in each space.
- Coverage stats against k: the share of each gamut inside the box, and the share of the box filled by each gamut.
- Lab white: D65, or D50 with Bradford adaptation.
- Renders in Display P3 where supported.

No build step. Serve the directory with any static server, e.g. `python3 -m http.server`. three.js r160 is vendored in `vendor/` (MIT).
