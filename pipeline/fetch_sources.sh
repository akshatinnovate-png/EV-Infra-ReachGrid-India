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
python3 fetch_osm.py substations raw/osm_substations.json

echo "[8] VAHAN registrations by RTO and month: fuel type, vehicle class, maker (India Data Portal mirror, ODC-BY)"
mkdir -p raw/idp
IDP=https://ckandev.indiadataportal.com/dataset/36ea3632-6ec7-43e6-8579-e8c80f7df640/resource
curl -fsSL --max-time 1200 -o raw/idp/fuel.csv   "$IDP/c9d109c7-8190-4a67-8166-0be1487db419/download/vehicle-registrations-by-fuel-type.csv" || echo "  IDP fuel-type table unavailable"
curl -fsSL --max-time 1200 -o raw/idp/vclass.csv "$IDP/cc32d3e2-7ea3-4b6b-94ab-85e57f6a0a3a/download/registrations-by-vehicle-class.csv" || echo "  IDP vehicle-class table unavailable"
curl -fsSL --max-time 1800 -o raw/idp/maker.csv  "$IDP/fdbcf474-cef2-474c-993f-00c18134bfc8/download/registrations-by-maker.csv" || echo "  IDP maker table unavailable"

echo "[9] PM E-DRIVE location types from OpenStreetMap: fuel outlets, toll plazas, rail/bus stations, airports, govt premises"
python3 fetch_osm.py sites raw/osm_sites.json
