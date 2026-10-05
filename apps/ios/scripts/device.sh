#!/bin/zsh
# Builds Aegis (Release by default) and installs it on a connected iPhone.
#   npm run ios:device                 # first connected iPhone
#   AEGIS_DEVICE=<udid> npm run ios:device
#   AEGIS_CONFIG=Debug npm run ios:device
# Needs DEVELOPMENT_TEAM in apps/ios/Config/Local.xcconfig and Developer Mode on the phone.
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG=${AEGIS_CONFIG:-Release}
if ! grep -qs '^DEVELOPMENT_TEAM' Config/Local.xcconfig; then
  echo "Add your Apple team to apps/ios/Config/Local.xcconfig, e.g.: DEVELOPMENT_TEAM = ABCDE12345" >&2
  exit 1
fi
UDID=${AEGIS_DEVICE:-}
if [[ -z "$UDID" ]]; then
  LIST=$(mktemp)
  xcrun devicectl list devices -j "$LIST" >/dev/null
  UDID=$(python3 -c '
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") == "iOS" and d.get("connectionProperties", {}).get("pairingState") == "paired":
        print(hw["udid"]); break
' "$LIST")
  rm -f "$LIST"
fi
if [[ -z "$UDID" ]]; then
  echo "No paired iPhone found. Connect it by cable, trust this Mac, and turn on Developer Mode." >&2
  exit 1
fi
xcodegen generate >/dev/null
xcodebuild -project Aegis.xcodeproj -scheme Aegis -configuration "$CONFIG" \
  -destination "id=$UDID" -derivedDataPath build/device -allowProvisioningUpdates build \
  | grep -E "error:|\*\* BUILD" || true
APP="build/device/Build/Products/$CONFIG-iphoneos/Aegis.app"
[[ -d "$APP" ]] || { echo "Build failed." >&2; exit 1; }
BUNDLE=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist")
xcrun devicectl device install app --device "$UDID" "$APP"
xcrun devicectl device process launch --device "$UDID" "$BUNDLE"
