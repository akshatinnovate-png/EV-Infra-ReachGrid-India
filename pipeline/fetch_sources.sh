#!/usr/bin/env bash
# Downloads every raw source used by ReachGrid into pipeline/raw/.
# Re-run this, then `python3 pipeline/build.py`, to refresh the bundled data.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw/geo
GH=https://raw.githubusercontent.com

echo "[1/4] District boundaries, one file per state (udit-001/india-maps-data, Census 2011 codes + later splits)"
mkdir -p raw/geo/states
for s in andhra-pradesh arunachal-pradesh assam bihar chhattisgarh goa gujarat haryana himachal-pradesh jharkhand karnataka kerala \
  madhya-pradesh maharashtra manipur meghalaya mizoram nagaland odisha punjab rajasthan sikkim tamil-nadu telangana tripura \
  uttarakhand uttar-pradesh west-bengal andaman-and-nicobar-islands chandigarh dnh-and-dd delhi jammu-and-kashmir ladakh lakshadweep puducherry; do
  curl -fsSL -o "raw/geo/states/$s.geojson" "$GH/udit-001/india-maps-data/main/geojson/states/$s.geojson"
done

echo "[2/4] Public EV charging stations (reclaimchennai/india-ev-charging-dataset, ODbL 1.0)"
curl -fsSL -o raw/charging_stations.csv "$GH/reclaimchennai/india-ev-charging-dataset/main/data/charging_stations.csv"

echo "[3/4] Census of India 2011 district tables"
curl -fsSL -o raw/census2011_districts.csv "$GH/nishusharma1608/India-Census-2011-Analysis/master/india-districts-census-2011.csv"

echo "[4/4] Natural Earth 10m roads (public domain)"
curl -fsSL -o raw/ne_10m_roads.geojson "$GH/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson"

echo "[+] GeoNames places (all-the-cities npm package, data CC BY 4.0 GeoNames)"
TMPD=$(mktemp -d)
( cd "$TMPD" && npm pack --silent all-the-cities@3.1.0 >/dev/null && tar xzf all-the-cities-3.1.0.tgz )
cp "$TMPD/package/cities.pbf" raw/cities.pbf && rm -rf "$TMPD"
node decode_cities.js raw/cities.pbf raw/cities_in.json

echo "[5] Census 2011 district polygons (DataMeet, CC BY 4.0)"
mkdir -p raw/c2011
for e in shp dbf shx prj; do curl -fsSL -o raw/c2011/2011_Dist.$e "$GH/datameet/maps/master/Districts/Census_2011/2011_Dist.$e"; done

echo "[6] VAHAN electric and total two-wheeler registrations by state and month (2020-2024 exports)"
mkdir -p raw/vahan
for y in 2020-21 2021-22 2022-23 2023-24; do
  curl -fsSL -o "raw/vahan/${y}ev.csv" "$GH/narayanamalla/PS-EV-peneteration-in-india/main/data/raw/${y}ev.csv"
  curl -fsSL -o "raw/vahan/${y}.csv" "$GH/narayanamalla/PS-EV-peneteration-in-india/main/data/raw/${y}.csv"
done

echo "[7] Electricity infrastructure: WRI power plants (fallback) and OpenStreetMap substations (preferred)"
curl -fsSL -o raw/gppd.csv "$GH/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv"
Q='[out:json][timeout:900];area["ISO3166-1"="IN"][admin_level=2]->.in;(node["power"="substation"](area.in);way["power"="substation"](area.in););out center tags;'
for ep in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  if curl -fsSL --max-time 1000 --data-urlencode "data=$Q" -o raw/osm_substations.tmp "$ep" && python3 -c "import json,sys; d=json.load(open('raw/osm_substations.tmp')); sys.exit(0 if len(d.get('elements',[]))>1000 else 1)"; then
    mv raw/osm_substations.tmp raw/osm_substations.json; echo "  OSM substations from $ep"; break
  fi
  echo "  $ep failed; trying next"
done
