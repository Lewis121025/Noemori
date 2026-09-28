---
tags: [front, nested/one, "#hashed", 123]
tag: comma, split
status: active
priority: 2
draft: false
empty:
nestedmap:
  key: value
list:
  - one
  - two
  - [skip, me]
---

# Heading with #heading-tag

Body #plain and #UPPER and #nested/deep/tag here.
Pure number #123 and #12-3 are not tags.
Word-joined abc#nope and under_score#nope stay plain.
Double ##alsonot is skipped.
Escaped \#notatag stays plain; double escape \\#escaped counts.
CJK: 中文#标签 counts; #日本語 also counts.
Trailing punctuation #ends-here. And #slash/ drops the slash.

```text
#fence-excluded
```

Inline `#code-excluded` and math $x #math-excluded$ too.

Wiki [[Target#anchor-not-tag]] and aliased [[Target|#alias-not-tag]] stay links.

In [label #link-label-tag](./x.md#url-not-tag) the label tag counts.

<!-- #comment-excluded -->
