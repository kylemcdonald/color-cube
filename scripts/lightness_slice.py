#!/usr/bin/env python3
"""Render one CIELAB lightness slice of an RGB gamut as a square PNG.

The plane L* = const is flat in linear RGB (Y is linear in RGB), so its intersection with the unit cube is a convex
polygon. Its plane has the same normal at every L*, so one fixed in-plane frame (green to red across, blue to red and
green upward) orients every slice the same way. A Coons patch maps the unit square onto that polygon, and every point of the patch is an affine combination
of boundary points, so the whole image stays on the plane. The four vertices nearest the frame's diagonals become the image
corners. If the polygon has more than four vertices, the extra vertices sit along the sides; a triangle gets the
midpoint of its longest side as a fourth corner. For a quad the patch
reduces to bilinear interpolation. The linear values are then encoded with
the space's transfer function and written as a PNG with an embedded ICC profile.

    python3 scripts/lightness_slice.py --L 62.75 --space adobe -o adobe-L62.75.png
"""
import argparse
import struct
import zlib

import numpy as np

PRIMS = {
    'srgb': [(0.64, 0.33), (0.30, 0.60), (0.15, 0.06)],
    'p3': [(0.68, 0.32), (0.265, 0.69), (0.15, 0.06)],
    'adobe': [(0.64, 0.33), (0.21, 0.71), (0.15, 0.06)],
}
NAMES = {'srgb': 'sRGB', 'p3': 'Display P3', 'adobe': 'Adobe RGB (1998) compatible'}
ADOBE_G = 563 / 256


def xy2XYZ(x, y):
    return np.array([x / y, 1.0, (1 - x - y) / y])


WHITES = {'D65': xy2XYZ(0.3127, 0.329), 'D50': xy2XYZ(0.3457, 0.3585)}
ICC_D50 = np.array([0.9642, 1.0, 0.8249])
BFD = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])


def bradford(src, dst):
    s, d = BFD @ src, BFD @ dst
    return np.linalg.inv(BFD) @ np.diag(d / s) @ BFD


def rgb_to_xyz(space):
    P = np.array([xy2XYZ(*p) for p in PRIMS[space]]).T
    return P * np.linalg.solve(P, WHITES['D65'])


def encode(space, x):
    x = np.clip(x, 0, 1)
    if space == 'adobe':
        return x ** (1 / ADOBE_G)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * x ** (1 / 2.4) - 0.055)


def lab_finv(t):
    e = 6 / 29
    return t ** 3 if t > e else 3 * e * e * (t - 4 / 29)


def plane_frame(n):
    """Fixed in-plane axes for the planes n.x = const, the same at every L*: x runs from green toward red, y from blue
    toward red and green. Slices at different L* then come out in the same orientation."""
    nh = n / np.linalg.norm(n)
    proj = lambda v: v - (v @ nh) * nh
    R, G, B = np.eye(3)
    ex = proj(R - G); ex /= np.linalg.norm(ex)
    ey = np.cross(nh, ex)
    if ey @ proj((R + G) / 2 - B) < 0:
        ey = -ey
    return ex, ey


def slice_polygon(n, t):
    """Vertices of {x in [0,1]^3 : n.x = t}, clockwise in the plane_frame, their angles about the neutral axis, and
    the number of sides of the true slice."""
    pts = []
    for i in range(8):
        a = np.array([(i >> k) & 1 for k in range(3)], float)
        for k in range(3):
            if a[k]:
                continue
            b = a.copy(); b[k] = 1
            fa, fb = n @ a - t, n @ b - t
            if fa == 0:
                pts.append(a)
            elif fa * fb < 0:
                pts.append(a + (b - a) * fa / (fa - fb))
    pts = np.unique(np.round(pts, 12), axis=0)
    grey = np.full(3, t / n.sum())
    ex, ey = plane_frame(n)
    angle = lambda p: np.degrees(np.arctan2((p - grey) @ ey, (p - grey) @ ex))
    pts = pts[np.argsort(-angle(pts))]
    sides = len(pts)
    if sides == 3:  # near black or white: a triangle. Its longest side's midpoint becomes the fourth corner.
        i = max(range(3), key=lambda i: np.linalg.norm(pts[(i + 1) % 3] - pts[i]))
        pts = np.insert(pts, i + 1, (pts[i] + pts[(i + 1) % 3]) / 2, axis=0)
    return pts, angle(pts), sides


def polyline(pts, s):
    """Point at arc-length fraction s (array) along the polyline pts."""
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)]) / seg.sum()
    out = np.empty((len(s), 3))
    for c in range(3):
        out[:, c] = np.interp(s, cum, pts[:, c])
    return out


def pick_corners(poly, ang):
    """Indices of the vertices for the image corners TL, TR, BR, BL: the four that span the most area, assigned so
    each sits as close as possible to its corner's direction (135, 45, -45, -135 degrees in the plane_frame)."""
    from itertools import combinations
    m = len(poly)
    area = lambda q: 0.5 * np.linalg.norm(sum(np.cross(q[i], q[(i + 1) % len(q)]) for i in range(len(q))))
    quad = list(max(combinations(range(m), 4), key=lambda idx: area(poly[list(idx)])))  # clockwise, like poly
    target = np.array([135, 45, -45, -135])
    dev = lambda k: sum(abs((ang[quad[(k + i) % 4]] - target[i] + 180) % 360 - 180) for i in range(4))
    k = min(range(4), key=dev)
    return [quad[(k + i) % 4] for i in range(4)]


def coons(poly, corners, size):
    """Map the unit square onto a convex polygon (clockwise vertices) with the given TL, TR, BR, BL corner vertices."""
    m = len(poly)
    sides = [poly[[(corners[i] + j) % m for j in range((corners[(i + 1) % 4] - corners[i]) % m + 1)]] for i in range(4)]
    u = (np.arange(size) + 0.5) / size
    # side 0: top edge, left to right; 1: right edge, top to bottom; 2: bottom, right to left; 3: left, bottom to top
    top, right = polyline(sides[0], u), polyline(sides[1], u)
    bottom, left = polyline(sides[2], u)[::-1], polyline(sides[3], u)[::-1]
    P00, P10, P11, P01 = (poly[c] for c in corners)
    X, Y = u[None, :, None], u[:, None, None]
    return ((1 - Y) * top[None] + Y * bottom[None] + (1 - X) * left[:, None] + X * right[:, None]
            - ((1 - X) * (1 - Y) * P00 + X * (1 - Y) * P10 + X * Y * P11 + (1 - X) * Y * P01))


# ---------------------------------------------------------------- ICC v2 matrix/TRC profile
def s15(v):
    return struct.pack('>i', int(round(v * 65536)))


def icc_profile(space):
    M = bradford(WHITES['D65'], ICC_D50) @ rgb_to_xyz(space)  # D50-adapted colorants, as ICC requires
    desc_txt = NAMES[space].encode('ascii') + b'\0'
    desc = b'desc' + b'\0' * 4 + struct.pack('>I', len(desc_txt)) + desc_txt + b'\0' * 8 + b'\0' * 3 + b'\0' * 67
    if space == 'adobe':
        trc = b'curv' + b'\0' * 4 + struct.pack('>IH', 1, round(ADOBE_G * 256))
    else:
        lut = encode_inv_table()
        trc = b'curv' + b'\0' * 4 + struct.pack('>I', len(lut)) + b''.join(struct.pack('>H', v) for v in lut)
    xyz = lambda v: b'XYZ ' + b'\0' * 4 + b''.join(s15(c) for c in v)
    tags = [(b'desc', desc), (b'cprt', b'text' + b'\0' * 4 + b'No copyright, use freely\0'), (b'wtpt', xyz(ICC_D50)),
            (b'rXYZ', xyz(M[:, 0])), (b'gXYZ', xyz(M[:, 1])), (b'bXYZ', xyz(M[:, 2])),
            (b'rTRC', trc), (b'gTRC', trc), (b'bTRC', trc)]
    off = 128 + 4 + 12 * len(tags)
    table, data, seen = b'', b'', {}
    for sig, body in tags:
        if body not in seen:
            pad = (-len(data)) % 4
            data += b'\0' * pad
            seen[body] = off + len(data)
            data += body
        table += sig + struct.pack('>II', seen[body], len(body))
    total = off + len(data)
    hdr = (struct.pack('>I', total) + b'none' + bytes([2, 0x10, 0, 0]) + b'mntr' + b'RGB ' + b'XYZ '
           + b'\0' * 12 + b'acsp' + b'\0' * 4 + b'\0' * 4 + b'\0' * 8 + b'\0' * 8 + struct.pack('>I', 0)
           + b''.join(s15(c) for c in ICC_D50) + b'none' + b'\0' * 16 + b'\0' * 28)
    assert len(hdr) == 128
    return hdr + struct.pack('>I', len(tags)) + table + data


def encode_inv_table(n=1024):
    x = np.linspace(0, 1, n)
    y = np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)
    return [int(round(v * 65535)) for v in y]


# ---------------------------------------------------------------- PNG
def write_png(path, rgb, bits, icc, icc_name):
    h, w, _ = rgb.shape
    mx = (1 << bits) - 1
    q = np.round(rgb * mx).astype('>u2' if bits == 16 else 'u1')
    raw = b''.join(b'\0' + q[y].tobytes() for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bits, 2, 0, 0, 0)))
        f.write(chunk(b'iCCP', icc_name.encode('latin-1') + b'\0\0' + zlib.compress(icc, 9)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--L', type=float, default=62.75, help='CIELAB L* of the slice')
    ap.add_argument('--space', choices=list(PRIMS), default='adobe')
    ap.add_argument('--white', choices=['D65', 'D50'], default='D65', help='Lab reference white (D50 = Bradford-adapted)')
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--bits', type=int, choices=[8, 16], default=8)
    ap.add_argument('-o', '--out', default=None)
    a = ap.parse_args()

    # L* fixes Y in the Lab-white XYZ, which is linear in RGB: n . rgb = t
    A = np.eye(3) if a.white == 'D65' else bradford(WHITES['D65'], WHITES['D50'])
    n = (A @ rgb_to_xyz(a.space))[1]
    t = WHITES[a.white][1] * lab_finv((a.L + 16) / 116)
    poly, ang, sides = slice_polygon(n, t)
    corners = pick_corners(poly, ang)
    img = coons(poly, corners, a.size)

    # sanity: on the plane, inside the cube, and orientation-preserving everywhere (so the map is one-to-one)
    off_plane = np.abs(img @ n - t).max()
    J = np.cross(np.diff(img, axis=1)[:-1], np.diff(img, axis=0)[:, :-1]) @ n
    assert off_plane < 1e-9 and img.min() > -1e-9 and img.max() < 1 + 1e-9
    assert (J > 0).all() or (J < 0).all(), 'Coons map folds over; polygon too irregular'

    out = a.out or f'{a.space}-L{a.L:g}.png'
    write_png(out, encode(a.space, img), a.bits, icc_profile(a.space), NAMES[a.space])
    print(f'{NAMES[a.space]}  L* = {a.L}  ({a.white})  Y = {t:.5f}  -> {sides}-gon, {a.size}x{a.size} {a.bits}-bit  {out}')
    lbl = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
    for i, v in enumerate(poly):
        tag = lbl[corners.index(i)] if i in corners else 'along a side'
        print(f'  linear RGB ({v[0]:.4f}, {v[1]:.4f}, {v[2]:.4f})  at {ang[i]:7.1f} deg  {tag}')


if __name__ == '__main__':
    main()
