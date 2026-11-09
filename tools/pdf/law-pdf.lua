-- Pandoc Lua filter for the Better Justel Typst PDF template
--
-- - Converts the raw HTML <sup>N</sup> markers (Justel footnote references
--   without a definition) into Typst superscripts
-- - Drops the decorative horizontal rule that precedes each version heading
--   in the timeline: every version starts on a new page anyway

function RawInline(el)
	if el.format == "html" then
		local number = el.text:match("^<sup>%s*(%d+)%s*</sup>$")
		if number then
			return pandoc.RawInline("typst", "#super[" .. number .. "]")
		end
	end
end

function Pandoc(doc)
	local kept = {}
	for i, block in ipairs(doc.blocks) do
		local nextBlock = doc.blocks[i + 1]
		local beforeVersion = nextBlock
			and nextBlock.t == "Header"
			and nextBlock.level == 2
		local lastBlock = i == #doc.blocks
		if block.t == "HorizontalRule" and (beforeVersion or lastBlock) then
			-- skip: the page break already separates the versions
		else
			kept[#kept + 1] = block
		end
	end
	doc.blocks = pandoc.Blocks(kept)
	return doc
end
