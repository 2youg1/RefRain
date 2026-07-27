---
name: refrain
description: Write for a human author inside RefRain. Use when a prompt arrives with a "# Before / # Request" file, mentions Edit Scopes or scope IDs like s1, or asks you to write a Result Artifact. Covers the one file you write, the format it must have, and the verdicts that come back.
---

# RefRain

RefRain is a writing app. A human owns the manuscript. You propose; they decide.

You never touch their file.

## The loop

```
author selects text  ->  writes an instruction  ->  you run
   ->  you write ONE file  ->  app shows it as a proposal
   ->  author accepts or rejects, slice by slice
   ->  accepted text enters the manuscript
```

Six steps. You are step three.

## What you receive

One file. Three sections, in this order:

```markdown
# Before

[the selected text, one block per scope]

# Request

[what the author asked for]

# Agent reply

[empty — yours to fill]
```

Read the first two. Write the third. Do not edit the first two.

Each block under `# Before` has an ID: `s1`, `s2`, `s3`. The app assigned them. Use them exactly.

## What you write

Replace the empty `# Agent reply` section with one XML element:

```xml
<agent-result version="1">
  <replacement scope="s1" format="markdown"><![CDATA[your new text]]></replacement>
  <comments>
    <comment target="s2"><![CDATA[your note about s2]]></comment>
  </comments>
</agent-result>
```

That is the whole reply. Nothing before it. Nothing after it.

### Five rules

1. **One root.** `<agent-result>` wraps everything. No prose outside it.
2. **One replacement per scope.** Two `<replacement scope="s1">` invalidates the file.
3. **Real IDs only.** An ID you invented invalidates that comment.
4. **CDATA always.** Wrap every text body in `<![CDATA[ ... ]]>`.
5. **Rewrite or comment — say which.** Give a scope a `<replacement>`, or a `<comment>`, or nothing.

### Three shapes

| You want to | You write |
|---|---|
| Rewrite s1 | `<replacement scope="s1" format="markdown"><![CDATA[new text]]></replacement>` |
| Delete s1 | `<replacement scope="s1" />` |
| Only comment on s1 | `<comment target="s1"><![CDATA[note]]></comment>` |

### One example, complete

Received:

```markdown
# Before

s1: The meeting was productive and we discussed many things.
s2: Everyone agreed.

# Request

Cut the filler. Keep it factual.

# Agent reply
```

Written:

```xml
<agent-result version="1">
  <replacement scope="s1" format="markdown"><![CDATA[The meeting settled the budget and the launch date.]]></replacement>
  <comments>
    <comment target="s2"><![CDATA[Left as is — "everyone agreed" is a fact, not filler. Name who, if you have it.]]></comment>
  </comments>
</agent-result>
```

## What the author sees

Not your file. A review panel.

Your `s1` rewrite appears beside their original, word-level differences highlighted. Your `s2` comment appears as a note on that paragraph.

Then they click, per scope:

- **accept** — your text goes in as written
- **accept-modified** — they edit your text first, then it goes in
- **reject** — nothing happens to the manuscript
- **comment-only** — your note is kept; the text is unchanged

Per scope. They can accept s1 and reject s2 in the same pass.

## What comes back

If they send verdicts to you, they arrive like this:

```xml
<changes>
<verdict n="1" ref="s1" kind="accept-modified">
  <final><![CDATA[The meeting settled the budget and the launch date, finally.]]></final>
  <reason>Kept it, added the exasperation. That's the register.</reason>
</verdict>
<verdict n="2" ref="s2" kind="reject">
  <reason>I do have the names. Not your job to guess.</reason>
</verdict>
</changes>
```

Read `<reason>`. That is the author teaching you their standard.

`<final>` is what actually landed. If it differs from what you wrote, the difference is the correction. Carry it forward.

A verdict may have no `<reason>`. That means no reason was given — not that the reason was empty. Do not invent one.

## Failure

Malformed XML, an invented scope ID, two replacements for one scope: the file is rejected whole. It is kept as a diagnostic. Nothing reaches the author.

There is no partial credit and no retry loop. Get the format right the first time.

## Never

- Never write to the manuscript files. You write one file, at the path you were given.
- Never invent a scope ID.
- Never put prose outside `<agent-result>`. Prose belongs in `<comment>`.
- Never report a price or a cost. Token counts only, exactly as your harness reports them.

## Checklist

Before you finish, confirm:

- [ ] The file has all three sections, first two unchanged
- [ ] `# Agent reply` holds exactly one `<agent-result version="1">`
- [ ] Every `scope` and `target` ID came from `# Before`
- [ ] No scope has two replacements
- [ ] Every text body is wrapped in CDATA
- [ ] Nothing outside the root element
