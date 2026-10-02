#!/bin/sh
set -eu
: "${ARTIFACT_ROOT:?Set ARTIFACT_ROOT to retained evidence directory}"
repo=$(pwd)
mkdir -p "$ARTIFACT_ROOT"
export PROOF_SOURCE_HEAD="$(git rev-parse HEAD)"
export PROOF_SOURCE_STATUS="$(git status --porcelain)"
name="pi-visibility-proof-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
# Dependencies installed only inside this owned disposable container.
wrapper_mount=""
if [ -n "${PROOF_OWNER_WRAPPER:-}" ]; then
 wrapper_mount="--mount type=bind,src=$(dirname "$PROOF_OWNER_WRAPPER"),dst=/owner,readonly"
 export PROOF_OWNER_WRAPPER="/owner/$(basename "$PROOF_OWNER_WRAPPER")"
fi
docker run --name "$name" -e PROOF_SOURCE_HEAD -e PROOF_SOURCE_STATUS -e PROOF_OWNER_WRAPPER $wrapper_mount --mount "type=bind,src=$repo,dst=/source,readonly" --mount "type=bind,src=$ARTIFACT_ROOT,dst=/evidence" node:24-bookworm sh -ec '
 apt-get update >/evidence/apt.log 2>&1
 apt-get install -y python3 >>/evidence/apt.log 2>&1
 npm install -g @earendil-works/pi-coding-agent@0.99.2 >/evidence/install.log 2>&1
 cp -R /source /work
 cd /work
 node --version > /evidence/node-version.txt
 python3 -c '\''import os,json,hashlib,pathlib; r=pathlib.Path("/work"); files={str(p.relative_to(r)):hashlib.sha256(p.read_bytes()).hexdigest() for p in r.rglob("*") if p.is_file() and not any(x in p.parts for x in [".git","node_modules","__pycache__"])};pathlib.Path("/evidence/linux-source-hashes.json").write_text(json.dumps({"head":os.environ["PROOF_SOURCE_HEAD"],"dirty":os.environ["PROOF_SOURCE_STATUS"],"sha256":files},indent=2))'\''
 result=0
 npm pack --json --pack-destination /evidence >/evidence/linux-pack.json
 mkdir /archive
 tar -xzf /evidence/pi-response-visibility-0.1.0.tgz -C /archive
 for suite in tui providers clocks storage storage-raw controls owner install-source install-archive; do
  extra=""; [ "$suite" != providers ] || extra="--case all"
  destination="/evidence/linux-$suite"; [ "$suite" != tui ] || destination=/evidence/linux
  script="$suite"
  case "$suite" in
   install-source) script=install; extra="--package-root /work" ;;
   install-archive) script=install; extra="--package-root /archive/package" ;;
  esac
  status=0
  python3 "tests/$script.py" $extra --artifact-root "$destination" --pi-root /usr/local/lib/node_modules/@earendil-works/pi-coding-agent >"/evidence/linux-$suite.log" 2>&1 || status=$?
  printf "%s\n" "$status" >"/evidence/linux-$suite.exit"
  [ "$status" = 0 ] || result=1
 done
 exit "$result"
'
