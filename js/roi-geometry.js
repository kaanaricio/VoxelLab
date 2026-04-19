// Point-in-shape tests for ROI tool (ellipse + polygon).

/** Inclusion predicate for an ellipse inscribed in the bounding box of two corner points. */
export function ellipseInclusion(pts) {
  const [[x1, y1], [x2, y2]] = pts;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2 || 1;
  const ry = Math.abs(y2 - y1) / 2 || 1;
  return (x, y) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };
}

/** Even-odd ray cast for polygon inclusion. */
export function polygonInclusion(verts) {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const [xi, yi] = verts[i];
      const [xj, yj] = verts[j];
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };
}
