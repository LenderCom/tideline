// @vitest-environment happy-dom
import { Editor, type AnyExtension } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { mentionPlugin } from '../src/mention.js';
import { isAllowedDocHref, isAllowedImageSrc, type DocSchemaConfig } from '../src/schema.js';
import { docSchemaExtensions, docToMarkdown, markdownToDoc } from './grammar.js';

/**
 * The schema's browser side: what it reads from pasted HTML, the HTML it renders (the clipboard's other half)
 * and its input rules. The codec never calls these, so they run in a DOM of their own; everything else in the package
 * runs under plain Node. An editor's menus, pickers and uploads are its own.
 */
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function mount(body = '', config: DocSchemaConfig = {}): { editor: Editor; markdown: () => string } {
  const editor = new Editor({ extensions: docSchemaExtensions(config) as AnyExtension[], content: markdownToDoc(body) });
  editors.push(editor);
  return { editor, markdown: () => docToMarkdown(editor.getJSON()) };
}

/** Type as keystrokes do: through ProseMirror's text input, so input rules see it. */
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (fn) => fn(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

describe('docSchema', () => {
  it('allows only the links and image sources the format can write', () => {
    expect(isAllowedDocHref('https://x.test/a')).toBe(true);
    expect(isAllowedDocHref('#D28.9')).toBe(true);
    expect(isAllowedDocHref('http://x.test')).toBe(false);
    expect(isAllowedDocHref('javascript:alert(1)')).toBe(false);
    expect(isAllowedImageSrc('attachment:att-1')).toBe(true);
    expect(isAllowedImageSrc('https://x.test/a.png')).toBe(true);
    expect(isAllowedImageSrc('data:image/png;base64,AAA')).toBe(false);
  });

  it('reads pasted HTML through the schema: callouts, diagrams, page links, safe images, tasks, anchors, aligned cells', () => {
    const { editor, markdown } = mount();
    editor.commands.setContent(
      [
        '<h2 data-anchor="pin">Pinned</h2>',
        '<aside data-callout="warning" data-title="Careful"><p>Inside</p></aside>',
        '<aside data-callout="bogus"><p>Unknown kind</p></aside>',
        '<pre data-mermaid=""><code>graph TD; A--&gt;B</code></pre>',
        '<p>See <span data-page-link="D1" data-label="Deploy">Deploy</span> and <img src="attachment:a1" alt="shot"><img src="https://evil.test/p.gif" alt="pixel"><img src="data:image/png;base64,AA" alt="inline"><img src="attachment:a2"></p>',
        '<ul><li data-checked="true"><p>done</p></li><li data-checked="false"><p>todo</p></li><li><p>plain</p></li></ul>',
        '<table><tr><th style="text-align: center">a</th><th align="right">b</th><th align="justify">c</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
      ].join(''),
    );
    expect(markdown()).toBe(
      [
        '## Pinned {#pin}',
        ':::warning Careful\nInside\n:::',
        ':::note\nUnknown kind\n:::',
        '```mermaid\ngraph TD; A-->B\n```',
        'See [[D1|Deploy]] and ![shot](attachment:a1)![pixel](https://evil.test/p.gif)![](attachment:a2)',
        '- [x] done\n- [ ] todo\n- plain',
        '| a | b | c |\n| :---: | ---: | --- |\n| 1 | 2 | 3 |',
      ].join('\n\n'),
    );
    // And renders HTML that reads back the same (the clipboard's HTML side).
    const html = editor.getHTML();
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain('data-title="Careful"');
    expect(html).toContain('data-anchor="pin"');
    expect(html).toContain('data-page-link="D1"');
    expect(html).toContain('data-label="Deploy"');
    expect(html).toContain('data-mermaid=""');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('text-align: center');
    const before = markdown();
    editor.commands.setContent(html);
    expect(markdown()).toBe(before);
  });

  it('writes page links and mentions as their markdown in plain text (the clipboard text side)', () => {
    const { editor } = mount('See [[D1]], [[D2|Deploy]] and <@u-1>.');
    expect(editor.getText()).toBe('See [[D1]], [[D2|Deploy]] and <@u-1>.');
    expect(editor.getHTML()).toContain('>D1</span>');
  });

  it('turns `[ ] ` at the start of a list item into a task, and ```mermaid into a diagram', () => {
    const { editor, markdown } = mount('- x');
    editor.commands.setTextSelection(3);
    editor.commands.deleteRange({ from: 3, to: 4 });
    type(editor, '[x] ');
    expect(markdown()).toBe('- [x] ');
    type(editor, 'task');
    expect(markdown()).toBe('- [x] task');
    // Only at the start of a list item: mid-line, or in a paragraph of its own, it stays text.
    type(editor, ' [ ] ');
    expect(markdown()).toBe('- [x] task [ ] ');
    const plain = mount('');
    type(plain.editor, '[ ] ');
    expect(plain.editor.getText()).toBe('[ ] ');
    expect(plain.editor.isActive('listItem')).toBe(false);
    const fresh = mount('');
    type(fresh.editor, '```mermaid ');
    expect(fresh.editor.isActive('mermaid')).toBe(true);
  });

  it('keeps marks off inline atoms, which Yjs could not sync: bold over a mention, a break typed in bold', () => {
    const { editor, markdown } = mount('Ask <@u-1> on [[D1]] ![i](attachment:k)\nnow');
    editor.chain().selectAll().toggleBold().run();
    const atoms: Array<{ type: string; marks: number }> = [];
    editor.state.doc.descendants((node) => {
      if (node.isInline && !node.isText) atoms.push({ type: node.type.name, marks: node.marks.length });
    });
    expect(atoms).toEqual([
      { type: 'mention', marks: 0 },
      { type: 'pageLink', marks: 0 },
      { type: 'image', marks: 0 },
      { type: 'hardBreak', marks: 0 },
    ]);
    expect(markdown()).toBe('**Ask** <@u-1> **on** [[D1]] ![i](attachment:k)\n**now**');
    // Shift+Enter inside bold text: the break inherits the bold, and loses it in the same update.
    editor.commands.setTextSelection(3);
    editor.commands.setHardBreak();
    const breaks: number[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') breaks.push(node.marks.length);
    });
    expect(breaks).toEqual([0, 0]);
    // A selection change alone has nothing to take off.
    editor.commands.setTextSelection(1);
    expect(markdown()).toBe('**As**\n**k** <@u-1> **on** [[D1]] ![i](attachment:k)\n**now**');
  });

  it('takes the editor’s node views and mention picker without changing the schema', () => {
    const view = () => ({ dom: document.createElement('div') });
    const { editor, markdown } = mount(':::tip T\nx\n:::\n\n- [ ] a <@u-1> [[p]] ![i](attachment:k)\n\n```ts\ny\n```', {
      views: { callout: view, codeBlock: view, listItem: view, mermaid: view, pageLink: view, image: view },
      plugins: [mentionPlugin({ view, suggestion: { char: '@', items: () => [] } })],
    });
    expect(markdown()).toBe(':::tip T\nx\n:::\n\n- [ ] a <@u-1> [[p]] ![i](attachment:k)\n\n```ts\ny\n```');
    expect(editor.schema.spec.nodes.size).toBe(mount('').editor.schema.spec.nodes.size);
  });
});
