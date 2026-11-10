// Pandoc/Typst template producing a clean PDF of a consolidated law text
// exported by betterlaws. See the "pdf" recipe of the justfile.

$if(title)$
#set document(title: [$title$], author: ("betterlaws",))
$endif$

// Pandoc emits different Typst for Markdown horizontal rules depending on
// its version: "#horizontalrule" (a content variable) up to pandoc 3.10,
// "#divider()" (a function call) from pandoc 3.11 on — define both
#let horizontalrule = line(start: (30%, 0%), end: (70%, 0%), stroke: 0.5pt + luma(160))
#let divider = () => horizontalrule

#set page(
  paper: "a4",
  margin: (top: 2.6cm, bottom: 2.1cm, x: 2.3cm),
  header: context [
    #set text(size: 8pt, fill: luma(110), style: "italic")
    #if counter(page).get().at(0) > 1 [$title$]
  ],
  footer: context [
    #set text(size: 8.5pt, fill: luma(110))
    #align(center)[#counter(page).display("1 / 1", both: true)]
  ],
)

#set text(font: "Libertinus Serif", size: 10.5pt, lang: "fr")
#set par(justify: true, leading: 0.72em)
#set block(above: 1.05em, below: 1.05em)

#show heading: set text(font: "Libertinus Serif", fill: luma(30))
#show heading.where(level: 1): set text(size: 15.5pt)
#show heading.where(level: 2): set text(size: 13pt)
#show heading.where(level: 3): set text(size: 11.5pt)
#show heading.where(level: 4): set text(size: 10.8pt)
#show heading.where(level: 5): set text(size: 10.5pt)
#show heading.where(level: 6): set text(size: 10.5pt)

#show quote: it => block(
  above: 1.1em,
  below: 1.1em,
  inset: (x: 0.9em, y: 0.65em),
  stroke: (left: 2pt + luma(180)),
  fill: luma(248),
  width: 100%,
  text(size: 9.5pt, fill: luma(60), it.body),
)

#show footnote.entry: set text(size: 8.5pt)
#show link: set text(fill: rgb("#1f4e79"))

$body$
