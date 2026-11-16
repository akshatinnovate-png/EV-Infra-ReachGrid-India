// Decodes the GeoNames protobuf shipped in the `all-the-cities` npm package (MIT; data CC-BY GeoNames)
// and keeps Indian places. Treats the file purely as data. Requires `npm i pbf@3`.
const fs = require('fs'), Pbf = require('pbf');
const pbf = new Pbf(fs.readFileSync(process.argv[2]));
let lat = 0, lon = 0; const out = [];
function rd(tag, c, p) {
  if (tag === 2) c.n = p.readString(); else if (tag === 3) c.c = p.readString();
  else if (tag === 7) c.f = p.readString(); else if (tag === 8) c.a = p.readString();
  else if (tag === 9) c.p = p.readVarint();
  else if (tag === 10) { lon += p.readSVarint(); c.lon = lon / 1e5 }
  else if (tag === 11) { lat += p.readSVarint(); c.lat = lat / 1e5 }
  else if (tag === 1) p.readSVarint(); else if (tag >= 4 && tag <= 6) p.readString();
}
while (pbf.pos < pbf.length) { const c = pbf.readMessage(rd, { n: '', c: '', f: '', a: '', p: 0 }); if (c.c === 'IN') out.push(c) }
fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log(`${out.length} Indian places written`);
