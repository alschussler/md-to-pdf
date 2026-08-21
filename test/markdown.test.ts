import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../src/markdown/block.ts';
import { plainText } from '../src/markdown/inline.ts';
import type { Block, Inline } from '../src/markdown/types.ts';

function blocks(source: string): Block[] {
  return parseMarkdown(source).blocks;
}

function only(source: string): Block {
  const result = blocks(source);
  assert.equal(result.length, 1, `expected exactly one block, got ${result.map((b) => b.type).join(', ')}`);
  return result[0];
}

function inlineOf(source: string): Inline[] {
  const block = only(source);
  assert.equal(block.type, 'paragraph');
  return block.children;
}

function shape(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text': return JSON.stringify(node.value);
        case 'code': return `code(${JSON.stringify(node.value)})`;
        case 'image': return `image(${node.src},${JSON.stringify(node.alt)})`;
        case 'break': return 'break';
        case 'link': return `link(${node.href}${node.title === null ? '' : `,${JSON.stringify(node.title)}`})[${shape(node.children)}]`;
        default: return `${node.type}[${shape(node.children)}]`;
      }
    })
    .join(' ');
}

test('emphasis and strong nest correctly', () => {
  assert.equal(shape(inlineOf('*foo*')), 'em["foo"]');
  assert.equal(shape(inlineOf('_foo_')), 'em["foo"]');
  assert.equal(shape(inlineOf('**foo**')), 'strong["foo"]');
  assert.equal(shape(inlineOf('__foo__')), 'strong["foo"]');
  assert.equal(shape(inlineOf('***foo***')), 'em[strong["foo"]]');
  assert.equal(shape(inlineOf('**foo *bar* baz**')), 'strong["foo " em["bar"] " baz"]');
  assert.equal(shape(inlineOf('*foo **bar** baz*')), 'em["foo " strong["bar"] " baz"]');
  assert.equal(shape(inlineOf('~~foo~~')), 'del["foo"]');
  assert.equal(shape(inlineOf('**a** and **b**')), 'strong["a"] " and " strong["b"]');
});

test('underscores do not split words but asterisks do', () => {
  assert.equal(shape(inlineOf('foo_bar_baz')), '"foo_bar_baz"');
  assert.equal(shape(inlineOf('foo*bar*baz')), '"foo" em["bar"] "baz"');
  assert.equal(shape(inlineOf('5 * 3 * 2')), '"5 * 3 * 2"');
});

test('unmatched delimiters stay literal', () => {
  assert.equal(shape(inlineOf('a * b')), '"a * b"');
  assert.equal(shape(inlineOf('**unclosed')), '"**unclosed"');
  assert.equal(shape(inlineOf('a ~ b')), '"a ~ b"');
});

test('code spans keep their content verbatim', () => {
  assert.equal(shape(inlineOf('`a*b*c`')), 'code("a*b*c")');
  assert.equal(shape(inlineOf('`` a`b ``')), 'code("a`b")');
  assert.equal(shape(inlineOf('`` ` ``')), 'code("`")');
  assert.equal(shape(inlineOf('a `b` c')), '"a " code("b") " c"');
});

test('code span fences must close with a run of the same length', () => {
  assert.equal(shape(inlineOf('`` a ``` b ``')), 'code("a ``` b")');
  assert.equal(shape(inlineOf('`a``b`')), 'code("a``b")');
  assert.equal(shape(inlineOf('``unclosed`')), '"``unclosed`"');
});

test('escapes and entities', () => {
  assert.equal(shape(inlineOf('\\*not em\\*')), '"*not em*"');
  assert.equal(shape(inlineOf('a \\\\ b')), '"a \\\\ b"');
  assert.equal(shape(inlineOf('&amp; &lt; &#65; &#x42;')), '"& < A B"');
  assert.equal(shape(inlineOf('&nosuchentity;')), '"&nosuchentity;"');
});

test('links, images and autolinks', () => {
  assert.equal(shape(inlineOf('[t](/u)')), 'link(/u)["t"]');
  assert.equal(shape(inlineOf('[t](/u "ti")')), 'link(/u,"ti")["t"]');
  assert.equal(shape(inlineOf('[t](<a b>)')), 'link(a b)["t"]');
  assert.equal(shape(inlineOf('[a [b] c](/u)')), 'link(/u)["a [b] c"]');
  assert.equal(shape(inlineOf('![alt](/i.png)')), 'image(/i.png,"alt")');
  assert.equal(shape(inlineOf('<https://x.dev>')), 'link(https://x.dev)["https://x.dev"]');
  assert.equal(shape(inlineOf('<a@b.dev>')), 'link(mailto:a@b.dev)["a@b.dev"]');
  assert.equal(shape(inlineOf('see https://x.dev/p.')), '"see " link(https://x.dev/p)["https://x.dev/p"] "."');
  assert.equal(shape(inlineOf('[not a link]')), '"[not a link]"');
});

test('reference links resolve in both directions', () => {
  assert.equal(shape(inlineOf('[t][r]\n\n[r]: /u "ti"')), 'link(/u,"ti")["t"]');
  assert.equal(shape(inlineOf('[r]: /u\n\n[t][r]')), 'link(/u)["t"]');
  assert.equal(shape(inlineOf('[R]: /u\n\n[collapsed][r]')), 'link(/u)["collapsed"]');
  assert.equal(shape(inlineOf('[short]: /u\n\n[short]')), 'link(/u)["short"]');
});

test('hard and soft breaks', () => {
  assert.equal(shape(inlineOf('a  \nb')), '"a" break "b"');
  assert.equal(shape(inlineOf('a\\\nb')), '"a" break "b"');
  assert.equal(shape(inlineOf('a\nb')), '"a b"');
  assert.equal(shape(inlineOf('a <br> b')), '"a " break " b"');
});

test('headings', () => {
  assert.deepEqual(only('# h1'), { type: 'heading', level: 1, children: [{ type: 'text', value: 'h1' }] });
  assert.equal((only('###### h6') as { level: number }).level, 6);
  assert.equal(plainText((only('## closed ##') as { children: Inline[] }).children), 'closed');
  assert.equal((only('Title\n=====') as { level: number }).level, 1);
  assert.equal((only('Title\n-----') as { level: number }).level, 2);
  assert.equal(only('####### seven').type, 'paragraph');
  assert.equal(only('#nospace').type, 'paragraph');
});

test('thematic breaks versus setext headings', () => {
  assert.equal(only('---').type, 'thematicBreak');
  assert.equal(only('***').type, 'thematicBreak');
  assert.equal(only('- - -').type, 'thematicBreak');
  const pair = blocks('para\n\n---');
  assert.deepEqual(pair.map((b) => b.type), ['paragraph', 'thematicBreak']);
});

test('code blocks', () => {
  const fenced = only('```js\nconst a = 1;\n```');
  assert.deepEqual(fenced, { type: 'codeBlock', lang: 'js', value: 'const a = 1;' });
  assert.equal((only('~~~\na ``` b\n~~~') as { value: string }).value, 'a ``` b');
  assert.equal((only('    indented\n    lines') as { value: string }).value, 'indented\nlines');
  assert.equal((only('```\n  keep   spacing\n```') as { value: string }).value, '  keep   spacing');
  assert.equal((only('```\nunterminated') as { value: string }).value, 'unterminated');
  assert.equal((only('~~~ a`b\nx\n~~~') as { lang: string }).lang, 'a`b');
  assert.equal(
    blocks('``` a`b\nx\n```')[0].type,
    'paragraph',
    'backtick fences reject backticks in the info string',
  );
  assert.equal(
    (only('    one\n\n    two') as { value: string }).value,
    'one\n\ntwo',
    'blank lines inside an indented code block are preserved',
  );
  const trailing = blocks('    code\n\nparagraph');
  assert.deepEqual(trailing.map((b) => b.type), ['codeBlock', 'paragraph']);
  assert.equal((trailing[0] as { value: string }).value, 'code');
});

test('blockquotes nest and allow lazy continuation', () => {
  const quote = only('> a\n> b') as { type: 'blockquote'; children: Block[] };
  assert.equal(quote.type, 'blockquote');
  assert.equal(plainText((quote.children[0] as { children: Inline[] }).children), 'a b');

  const lazy = only('> a\nb') as { children: Block[] };
  assert.equal(plainText((lazy.children[0] as { children: Inline[] }).children), 'a b');

  const nested = only('> > deep') as { children: Block[] };
  assert.equal(nested.children[0].type, 'blockquote');
});

test('lists: markers, nesting, tightness and numbering', () => {
  const tight = only('- a\n- b') as { type: 'list'; ordered: boolean; tight: boolean; items: unknown[] };
  assert.equal(tight.type, 'list');
  assert.equal(tight.ordered, false);
  assert.equal(tight.tight, true);
  assert.equal(tight.items.length, 2);

  const loose = only('- a\n\n- b') as { tight: boolean };
  assert.equal(loose.tight, false);

  const ordered = only('3. c\n4. d') as { ordered: boolean; start: number };
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);

  const nested = only('- a\n  - b\n    - c') as { items: { children: Block[] }[] };
  const inner = nested.items[0].children[1] as { type: string; items: { children: Block[] }[] };
  assert.equal(inner.type, 'list');
  assert.equal((inner.items[0].children[1] as { type: string }).type, 'list');

  const separate = blocks('- a\n\n* b');
  assert.equal(separate.length, 2, 'different bullet characters start a new list');
});

test('task list items', () => {
  const list = only('- [x] done\n- [ ] todo') as { items: { checked: boolean | null; children: Block[] }[] };
  assert.equal(list.items[0].checked, true);
  assert.equal(list.items[1].checked, false);
  assert.equal(plainText((list.items[0].children[0] as { children: Inline[] }).children), 'done');
  const plain = only('- regular') as { items: { checked: boolean | null }[] };
  assert.equal(plain.items[0].checked, null);
});

test('list items hold multiple blocks', () => {
  const list = only('1. first\n\n   second\n\n   ```\n   code\n   ```') as { items: { children: Block[] }[] };
  assert.deepEqual(list.items[0].children.map((b) => b.type), ['paragraph', 'paragraph', 'codeBlock']);
});

test('tables', () => {
  const table = only('| a | b |\n|:--|--:|\n| 1 | 2 |') as {
    type: 'table';
    align: (string | null)[];
    header: Inline[][];
    rows: Inline[][][];
  };
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.header.map(plainText), ['a', 'b']);
  assert.deepEqual(table.rows.map((row) => row.map(plainText)), [['1', '2']]);

  const centered = only('| a |\n| :-: |\n| 1 |') as { align: (string | null)[] };
  assert.deepEqual(centered.align, ['center']);

  const escaped = only('| a | b |\n| - | - |\n| x \\| y | z |') as { rows: Inline[][][] };
  assert.deepEqual(escaped.rows[0].map(plainText), ['x | y', 'z']);

  const ragged = only('| a | b |\n| - | - |\n| 1 |') as { rows: Inline[][][] };
  assert.deepEqual(ragged.rows[0].map(plainText), ['1', '']);

  assert.equal(only('| a | b\n| --- |').type, 'paragraph', 'mismatched delimiter row is not a table');
});

test('html is dropped rather than printed', () => {
  assert.deepEqual(blocks('<div>\n  <p>x</p>\n</div>').map((b) => b.type), []);
  assert.equal(shape(inlineOf('a <span class="x">b</span> c')), '"a b c"');
});

test('empty and whitespace-only documents', () => {
  assert.deepEqual(blocks(''), []);
  assert.deepEqual(blocks('\n\n   \n\t\n'), []);
});

test('CRLF, BOM and tabs are normalized', () => {
  assert.equal(only('﻿# h\r\n').type, 'heading');
  assert.equal((only('```\n\tindented\n```') as { value: string }).value, '    indented');
  const list = only('-\ta') as { items: { children: Block[] }[] };
  assert.equal(plainText((list.items[0].children[0] as { children: Inline[] }).children), 'a');
});
