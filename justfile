# Better Justel — offline tooling
#
# The extension exports law timelines as Markdown ("Timeline (MD/PDF)" >
# Download Markdown). These recipes turn the exported Markdown into clean
# typeset PDFs with Pandoc and Typst (both must be installed:
# https://pandoc.org and https://typst.app, or your distribution packages).
#
# The recipes are OS-agnostic: on Linux and macOS they run with sh,
# on Windows with PowerShell (bash is not needed).

# Use PowerShell on Windows (available on every Windows installation)
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# Options shared by all PDF conversions; paths are resolved from this
# justfile's directory so the recipes work from anywhere
pandoc-args := "--from gfm+yaml_metadata_block --pdf-engine=typst --template=\"" + (justfile_directory() / "tools/pdf/law-pdf.typ") + "\" --lua-filter=\"" + (justfile_directory() / "tools/pdf/law-pdf.lua") + "\" --metadata lang=fr"

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
