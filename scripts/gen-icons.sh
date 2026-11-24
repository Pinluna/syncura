#!/bin/bash
# Generates branded launcher, adaptive, splash and web icons from resources/logo.png.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOGO="resources/logo.png"
BRAND="#8B5CF6"

rrect() { # src out size radius
  magick "$1" -resize "$3x$3!" \
    \( -size "$3x$3" xc:none -fill white -draw "roundrectangle 0,0,$(( $3 - 1 )),$(( $3 - 1 )),$4,$4" \) \
    -alpha off -compose CopyOpacity -composite "$2"
}

circle() { # src out size
  local h=$(( $3 / 2 ))
  magick "$1" -resize "$3x$3!" \
    \( -size "$3x$3" xc:none -fill white -draw "circle ${h},${h} ${h},0" \) \
    -alpha off -compose CopyOpacity -composite "$2"
}

[ -f "$LOGO" ] || { echo "missing $LOGO" >&2; exit 1; }

mkdir -p public

echo "web icons"
rrect "$LOGO" public/favicon.png 192 42
rrect "$LOGO" public/apple-touch-icon.png 180 40
magick "$LOGO" -resize 512x512 public/logo.png

echo "android launcher icons"
for pair in "mdpi 48" "hdpi 72" "xhdpi 96" "xxhdpi 144" "xxxhdpi 192"; do
  dpi=${pair% *}
  size=${pair#* }
  dir="android/app/src/main/res/mipmap-$dpi"
  mkdir -p "$dir"

  rrect "$LOGO" "$dir/ic_launcher.png" "$size" $(( size * 22 / 100 ))
  circle "$LOGO" "$dir/ic_launcher_round.png" "$size"

  adaptive=$(( size * 108 / 48 ))
  inner=$(( adaptive * 66 / 100 ))
  rrect "$LOGO" .icon-fg.png "$inner" $(( inner * 22 / 100 ))
  magick .icon-fg.png -background none -gravity center -extent "${adaptive}x${adaptive}" \
    "$dir/ic_launcher_foreground.png"
  rm -f .icon-fg.png
  echo "  $dpi legacy=${size} adaptive=${adaptive}"
done

echo "adaptive icon background"
for pair in "mdpi 108" "hdpi 162" "xhdpi 216" "xxhdpi 324" "xxxhdpi 432"; do
  dpi=${pair% *}
  size=${pair#* }
  magick "$LOGO" -resize "${size}x${size}!" "android/app/src/main/res/mipmap-$dpi/ic_launcher_bg.png"
done

echo "splash screens"
for f in $(find android/app/src/main/res -name splash.png | sort); do
  read -r w h < <(identify -format "%w %h\n" "$f")
  mark=$(( w < h ? w * 30 / 100 : h * 30 / 100 ))
  rrect "$LOGO" .splash-mark.png "$mark" $(( mark * 22 / 100 ))
  magick -size "${w}x${h}" gradient:"$BRAND"-#6D28D9 \
    .splash-mark.png -gravity center -compose over -composite "$f"
  rm -f .splash-mark.png
  echo "  $f ${w}x${h}"
done

echo "done"