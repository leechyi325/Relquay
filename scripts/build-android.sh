#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${STUDIO_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${STUDIO_ANDROID_SDK:-$PWD/.runtime/android-sdk}"
export GRADLE_USER_HOME="$PWD/.runtime/gradle"
if [[ ! -d "$JAVA_HOME" || ! -d "$ANDROID_HOME/platforms/android-36" ]]; then
  echo 'Set STUDIO_JAVA_HOME (JDK 21) and STUDIO_ANDROID_SDK (SDK 36) before building.' >&2; exit 1
fi
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
npm run android:sync
(cd android && "${STUDIO_GRADLE:-./gradlew}" --no-daemon assembleDebug)
mkdir -p artifacts
version="$(node -p 'require("./package.json").version')"
artifact="artifacts/roamdeck-$version-debug.apk"
cp android/app/build/outputs/apk/debug/app-debug.apk "$artifact"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$artifact"
shasum -a 256 "$artifact"
