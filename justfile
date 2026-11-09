# Better Justel — offline tooling
#
# The extension exports law timelines as Markdown ("Timeline (MD/PDF)" >
# Download Markdown). These recipes turn the exported Markdown into clean
# typeset PDFs with Pandoc and Typst (both must be installed:
# https://pandoc.org and https://typst.app, or your distribution packages).

# Convert Markdown law timelines to clean PDFs (one PDF per file)
pdf file:
    #!/usr/bin/env bash
    set -euo pipefail
    out="{{ file }}"
    out="${out%.md}.pdf"
    pandoc "{{ file }}" \
        --from gfm+yaml_metadata_block \
        --pdf-engine=typst \
        --template=tools/pdf/law-pdf.typ \
        --lua-filter=tools/pdf/law-pdf.lua \
        --metadata lang=fr \
        -o "$out"
    echo "Created $out"

# Convert every Markdown file of a directory to a clean PDF (default: ./laws)
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
