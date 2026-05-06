#!/bin/bash
cd labs
git fetch origin main
git reset --hard origin/main
sudo systemctl restart toolshed@*
