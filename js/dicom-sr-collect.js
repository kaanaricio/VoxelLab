// Gather measurements / ROIs / annotations for SR export.
import { drawingEntriesForSeries } from './annotation-graph.js';

export function collectMeasurements(host) {
  const slug = host.manifest.series[host.seriesIdx].slug;
  const series = host.manifest.series[host.seriesIdx];
  const out = [];
  for (const entry of drawingEntriesForSeries(host, slug)) {
    if (entry.kind === 'line') {
      const m = entry.data;
      out.push({
        kind: 'length',
        slice: entry.sliceIdx,
        length_mm: m.mm,
        handles: [[m.x1, m.y1], [m.x2, m.y2]],
      });
    } else if (entry.kind === 'angle') {
      const a = entry.data;
      out.push({
        kind: 'angle',
        slice: entry.sliceIdx,
        angle_deg: a.deg,
        handles: [[a.p1.x, a.p1.y], [a.vertex.x, a.vertex.y], [a.p3.x, a.p3.y]],
      });
    } else if (entry.kind === 'ellipse' || entry.kind === 'polygon') {
      const r = entry.data;
      out.push({
        kind: entry.kind,
        slice: entry.sliceIdx,
        handles: r.pts,
        stats: r.stats,
      });
    } else if (entry.kind === 'note') {
      const n = entry.data;
      out.push({
        kind: 'text',
        slice: entry.sliceIdx,
        handles: [[n.x, n.y]],
        text: n.text || '',
      });
    }
  }

  return { slug, series, measurements: out };
}
