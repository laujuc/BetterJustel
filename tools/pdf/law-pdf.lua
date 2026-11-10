-- Pandoc Lua filter for the betterlaws Typst PDF template
--
-- - Converts the raw HTML <sup>..</sup> and <sub>..</sub> pairs (Justel and
--   Fisconet ordinals such as 1<sup>er</sup>, footnote markers without a
--   definition, CO<sub>2</sub>) into real superscripts/subscripts. The Pandoc
--   gfm reader emits the opening and closing tags as separate raw inlines.
-- - Drops a horizontal rule that older timeline exports placed before each
--   version heading. Current exports are one consolidated text and do not emit it.

function Inlines(inlines)
	local out = pandoc.Inlines({})
	local i = 1
	while i <= #inlines do
		local el = inlines[i]
		local tag = el.t == "RawInline" and el.format == "html" and el.text:match("^<(su[pb])>$")
		local j = i + 1
		if tag then
			while j <= #inlines do
				local candidate = inlines[j]
				if candidate.t == "RawInline" and candidate.text == "</" .. tag .. ">" then
					break
				end
				j = j + 1
			end
		end
		if tag and j <= #inlines then
			local content = pandoc.Inlines({})
			for k = i + 1, j - 1 do
				content:insert(inlines[k])
			end
			if tag == "sup" then
				out:insert(pandoc.Superscript(content))
			else
				out:insert(pandoc.Subscript(content))
			end
			i = j + 1
		else
			out:insert(el)
			i = i + 1
		end
	end
	return out
end

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
			-- skip: leftover separator from an older timeline export
		else
			kept[#kept + 1] = block
		end
	end
	doc.blocks = pandoc.Blocks(kept)
	return doc
end
