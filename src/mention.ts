/// <reference types="@tiptap/extension-mention" preserve="true" />
import type { NodeViewRenderer } from '@tiptap/core';
import { Mention, type MentionOptions } from '@tiptap/extension-mention';
import type { MarkdownPlugin } from './plugin.js';

const MENTION_ID = /^[A-Za-z0-9_-]+$/;

export interface MentionPluginConfig {
  /** The `@` picker. Headless use needs none. */
  suggestion?: MentionOptions['suggestion'];
  /** The node view that draws a person's name. The markdown stores only the id. */
  view?: NodeViewRenderer;
}

/**
 * `<@user-id>` as a mention node. Opt in by passing it to every call that reads or writes a document:
 *
 *     const plugins = [mentionPlugin()];
 *     docSchemaExtensions({ plugins });
 *     markdownToDoc(body, { plugins });
 *     docToMarkdown(doc, { plugins });
 */
export function mentionPlugin(config: MentionPluginConfig = {}): MarkdownPlugin {
  return {
    type: 'mention',
    pattern: '<@[A-Za-z0-9_-]+>',
    read: (token) => ({ id: token.slice(2, -1) }),
    write: (attrs) => {
      const id = String(attrs.id ?? '');
      return MENTION_ID.test(id) ? `<@${id}>` : null;
    },
    extension: () => {
      const mention = Mention.configure({
        renderText: ({ node }) => `<@${String(node.attrs.id)}>`,
        ...(config.suggestion ? { suggestion: config.suggestion } : {}),
      });
      const { view } = config;
      return view ? mention.extend({ addNodeView: () => view }) : mention;
    },
  };
}
