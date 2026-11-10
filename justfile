# betterlaws — offline tooling
#
# The extension exports law timelines as Markdown ("Timeline (MD/PDF)" >
# Download Markdown). These recipes turn the exported Markdown into clean
# typeset PDFs with Pandoc and Typst (both must be installed:
# https://pandoc.org and https://typst.app, or your distribution packages).
#
# The recipes are OS-agnostic: on Linux and macOS they run with sh,
# on Windows with PowerShell (bash is not needed).

# Use PowerShell 7 on Windows (pwsh; https://learn.microsoft.com/powershell/scripting/install/installing-powershell)
# Windows PowerShell 5.1 also works: replace pwsh.exe with powershell.exe
set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

# Options shared by all PDF conversions; paths are resolved from this
# justfile's directory so the recipes work from anywhere
pdf-options := "--pdf-engine=typst --template=\"" + (justfile_directory() / "tools/pdf/law-pdf.typ") + "\" --lua-filter=\"" + (justfile_directory() / "tools/pdf/law-pdf.lua") + "\" --metadata lang=fr"
pandoc-args := "--from gfm+yaml_metadata_block " + pdf-options
# Fisconet Markdown has explicit article anchors (`#### Article 5/1 {#art-5-1}`)
fisconet-pandoc-args := "--from gfm+attributes+yaml_metadata_block " + pdf-options

# Convert Markdown law timelines to clean PDFs (one PDF per file)
pdf file:
    pandoc "{{ file }}" {{ pandoc-args }} -o "{{ without_extension(file) }}.pdf"
    @echo Created {{ without_extension(file) }}.pdf

# Convert every Markdown file of a directory to a clean PDF (default: ./laws)
[unix]
pdfs dir="laws":
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob
    found=0
    for file in "{{ dir }}"/*.md; do
        found=1
        just pdf "$file"
    done
    if [ "$found" -eq 0 ]; then
        echo "No .md files found in '{{ dir }}'" >&2
        exit 1
    fi

# Convert every Markdown file of a directory to a clean PDF (default: ./laws)
[windows]
pdfs dir="laws":
    Get-ChildItem -Path '{{ dir }}' -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object { just pdf $_.FullName }; if (-not (Get-ChildItem -Path '{{ dir }}' -Filter *.md -ErrorAction SilentlyContinue)) { Write-Error "No .md files found in '{{ dir }}'"; exit 1 }

# --- FisconetPlus (SPF Finances): Code des impôts sur les revenus, TVA, ... ---
# Requires Node.js 18+ (no npm packages) and Pandoc 3+.
#   just fisconet-list "cir 2027"       find the GUID of a code
#   just fisconet <guid-or-url>         download it -> fisconet/<name>/<name>.md (+ .html)
#   just fisconet-pdf fisconet/<name>/<name>.md
#   just fisconet-site fisconet/<name>  minimalist HTML site -> fisconet/<name>/site/
#   just fisconet-publish fisconet/<name>
#                                   upload that site to pgs.sh:/laws/<name>/

# List FisconetPlus documents (filter by words, e.g. "tva" or "cir revenus 2027")
fisconet-list filter="":
    node "{{ justfile_directory() / "tools/fisconet/fisconet.mjs" }}" list "{{ filter }}"

# Download a whole code from FisconetPlus to Markdown (options: --out DIR, --name NAME, --concurrency N, --refresh, --outline, --no-markdown)
fisconet target *options:
    node "{{ justfile_directory() / "tools/fisconet/fisconet.mjs" }}" get "{{ target }}" {{ options }}

# Convert a Fisconet Markdown file to a clean PDF
fisconet-pdf file:
    pandoc "{{ file }}" {{ fisconet-pandoc-args }} -o "{{ without_extension(file) }}.pdf"
    @echo Created {{ without_extension(file) }}.pdf

# Build a minimalist HTML site from a downloaded Fisconet code (writes DIR/site/, with a TOC sidebar)
fisconet-site dir *options:
    node "{{ justfile_directory() / "tools/fisconet/site.mjs" }}" "{{ dir }}" {{ options }}

# Upload that site to pico+ pages at pgs.sh:/laws/<name>/ (https://ljuc-laws.pgs.sh/<name>/). Prints the command; runs rsync when it is installed
fisconet-publish dir *options:
    node "{{ justfile_directory() / "tools/fisconet/site.mjs" }}" "{{ dir }}" --publish {{ options }}
