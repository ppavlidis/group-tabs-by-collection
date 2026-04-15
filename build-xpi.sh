#!/usr/bin/env bash
set -e
XPI="group-tabs-by-collection.xpi"
rm -f "$XPI"
zip -r "$XPI" manifest.json bootstrap.js group-tabs.js style.css updates.json content/
echo "Built $XPI"
