/* @flow */

import combineOrderedStyles from './helpers/combineOrderedStyles';
import normalizeAttributes from './helpers/normalizeAttributes';
import styleToCSS from './helpers/styleToCSS';

import {Entity} from 'draft-js';
import {
  getEntityRanges,
  BLOCK_TYPE,
  ENTITY_TYPE,
  INLINE_STYLE,
} from 'draft-js-utils';

import type {ContentState, ContentBlock, EntityInstance} from 'draft-js';
import type {CharacterMetaList} from 'draft-js-utils';

type AttrMap = {[key: string]: string};
type Attributes = {[key: string]: string};
type StyleDescr = {[key: string]: number | string};

type RenderConfig = {
  element?: string;
  attributes?: Attributes;
  style?: StyleDescr;
};

type BlockRenderer = (block: ContentBlock) => ?string;
type BlockRendererMap = {[blockType: string]: BlockRenderer};

type EntityData = {[key: string]: string | number};
type EntityGetter = (entityKey: string) => ?EntityInstance;
type EntityFormatter = (content: string, attrString: string, entityData: EntityData) => ?string;
type EntityFormatterMap = {[key: string]: EntityFormatter}
type EntityAttributesRenderer = (entityType: string, entity: EntityInstance) => ?Attributes;
type EntityAttributesRendererMap = {[key: string]: EntityAttributesRenderer}

type StyleMap = {[styleName: string]: RenderConfig};

type BlockStyleFn = (block: ContentBlock) => ?RenderConfig;

type Options = {
  inlineStyles?: StyleMap;
  blockRenderers?: BlockRendererMap;
  blockStyleFn?: BlockStyleFn;
  entityGetter?: EntityGetter;
  entityFormatterMap?: EntityFormatterMap;
  entityAttributesRendererMap?: EntityAttributesRendererMap;
};

const {
  BOLD,
  CODE,
  ITALIC,
  STRIKETHROUGH,
  UNDERLINE,
} = INLINE_STYLE;

const INDENT = '  ';
const BREAK = '<br>';
const DATA_ATTRIBUTE = /^data-([a-z0-9-]+)$/;

const DEFAULT_STYLE_MAP = {
  [BOLD]: {element: 'strong'},
  [CODE]: {element: 'code'},
  [ITALIC]: {element: 'em'},
  [STRIKETHROUGH]: {element: 'del'},
  [UNDERLINE]: {element: 'ins'},
};

// Order: inner-most style to outer-most.
// Examle: <em><strong>foo</strong></em>
const DEFAULT_STYLE_ORDER = [BOLD, ITALIC, UNDERLINE, STRIKETHROUGH, CODE];

// Map entity data to element attributes.
const ENTITY_ATTR_MAP: {[entityType: string]: AttrMap} = {
  [ENTITY_TYPE.LINK]: {url: 'href', rel: 'rel', target: 'target', title: 'title', className: 'class'},
  [ENTITY_TYPE.IMAGE]: {src: 'src', height: 'height', width: 'width', alt: 'alt', className: 'class'},
};

const ENTITY_FORMATTER_MAP: EntityFormatterMap = {
  [ENTITY_TYPE.LINK]: (content, attrString, entityData) => `<a${attrString}>${content}</a>`,
  [ENTITY_TYPE.IMAGE]: (content, attrString, entityData) => `<img${attrString}/>`,
  DEFAULT: (content, attrString, entityData) => `<span$attrString}>${content}</span>`
};

// Map entity data to element attributes.
function DATA_TO_ATTR(entityAttributesMap: AttrMap): EntityAttributesRendererMap {
    return {
        DEFAULT(entityType: string, entity: EntityInstance): Attributes {
            let attrMap = entityAttributesMap.hasOwnProperty(entityType) ? entityAttributesMap[entityType] : {};
            let data = entity.getData();
            let attrs = {};
            for (let dataKey of Object.keys(data)) {
                let dataValue = data[dataKey];
                if (attrMap.hasOwnProperty(dataKey)) {
                    let attrKey = attrMap[dataKey];
                    attrs[attrKey] = dataValue;
                } else if (DATA_ATTRIBUTE.test(dataKey)) {
                    attrs[dataKey] = dataValue;
                }
            }
            return attrs;
        }
    }
};

// The reason this returns an array is because a single block might get wrapped
// in two tags.
function getTags(blockType: string): Array<string> {
  switch (blockType) {
    case BLOCK_TYPE.HEADER_ONE:
      return ['h1'];
    case BLOCK_TYPE.HEADER_TWO:
      return ['h2'];
    case BLOCK_TYPE.HEADER_THREE:
      return ['h3'];
    case BLOCK_TYPE.HEADER_FOUR:
      return ['h4'];
    case BLOCK_TYPE.HEADER_FIVE:
      return ['h5'];
    case BLOCK_TYPE.HEADER_SIX:
      return ['h6'];
    case BLOCK_TYPE.UNORDERED_LIST_ITEM:
    case BLOCK_TYPE.ORDERED_LIST_ITEM:
      return ['li'];
    case BLOCK_TYPE.BLOCKQUOTE:
      return ['blockquote'];
    case BLOCK_TYPE.CODE:
      return ['pre', 'code'];
    case BLOCK_TYPE.ATOMIC:
      return ['figure'];
    default:
      return ['p'];
  }
}

function getWrapperTag(blockType: string): ?string {
  switch (blockType) {
    case BLOCK_TYPE.UNORDERED_LIST_ITEM:
      return 'ul';
    case BLOCK_TYPE.ORDERED_LIST_ITEM:
      return 'ol';
    default:
      return null;
  }
}

class MarkupGenerator {
  // These are related to state.
  blocks: Array<ContentBlock>;
  contentState: ContentState;
  currentBlock: number;
  indentLevel: number;
  output: Array<string>;
  totalBlocks: number;
  wrapperTag: ?string;
  entityGetter: EntityGetter;
  entityFormatterMap: EntityFormatterMap;
  entityAttributesMap: AttrMap;
  entityAttributesRendererMap: EntityAttributesRendererMap;
  // These are related to user-defined options.
  options: Options;
  inlineStyles: StyleMap;
  styleOrder: Array<string>;

  constructor(contentState: ContentState, options: ?Options) {
    if (options == null) {
      options = {};
    }
    this.contentState = contentState;
    this.options = options;
    this.entityGetter = Entity.get;
    this.entityFormatterMap = ENTITY_FORMATTER_MAP;
    this.entityAttributesMap = ENTITY_ATTR_MAP;
    this.entityAttributesRendererMap = DATA_TO_ATTR(this.entityAttributesMap);

    for(let key of ['entityFormatterMap', 'entityAttributesMap', 'entityAttributesRendererMap']){
        if(this.options.hasOwnProperty(key)) {
            Object.assign(this[key], options[key]);
        }
    }

    if(this.options.hasOwnProperty('entityGetter')) {
      this.entityGetter = options.entityGetter;
    }

    let [inlineStyles, styleOrder] = combineOrderedStyles(
      options.inlineStyles,
      [DEFAULT_STYLE_MAP, DEFAULT_STYLE_ORDER],
    );
    this.inlineStyles = inlineStyles;
    this.styleOrder = styleOrder;
  }

  generate(): string {
    this.output = [];
    this.blocks = this.contentState.getBlocksAsArray();
    this.totalBlocks = this.blocks.length;
    this.currentBlock = 0;
    this.indentLevel = 0;
    this.wrapperTag = null;
    while (this.currentBlock < this.totalBlocks) {
      this.processBlock();
    }
    this.closeWrapperTag();
    return this.output.join('').trim();
  }

  processBlock() {
    let {blockRenderers} = this.options;
    let block = this.blocks[this.currentBlock];
    let blockType = block.getType();
    let newWrapperTag = getWrapperTag(blockType);
    if (this.wrapperTag !== newWrapperTag) {
      if (this.wrapperTag) {
        this.closeWrapperTag();
      }
      if (newWrapperTag) {
        this.openWrapperTag(newWrapperTag);
      }
    }
    this.indent();
    // Allow blocks to be rendered using a custom renderer.
    let customRenderer = (blockRenderers != null && blockRenderers.hasOwnProperty(blockType)) ?
      blockRenderers[blockType] :
      null;
    let customRendererOutput = customRenderer ? customRenderer(block) : null;
    // Renderer can return null, which will cause processing to continue as normal.
    if (customRendererOutput != null) {
      this.output.push(customRendererOutput);
      this.output.push('\n');
      this.currentBlock += 1;
      return;
    }
    this.writeStartTag(block);
    this.output.push(this.renderBlockContent(block));
    // Look ahead and see if we will nest list.
    let nextBlock = this.getNextBlock();
    if (
      canHaveDepth(blockType) &&
      nextBlock &&
      nextBlock.getDepth() === block.getDepth() + 1
    ) {
      this.output.push(`\n`);
      // This is a litle hacky: temporarily stash our current wrapperTag and
      // render child list(s).
      let thisWrapperTag = this.wrapperTag;
      this.wrapperTag = null;
      this.indentLevel += 1;
      this.currentBlock += 1;
      this.processBlocksAtDepth(nextBlock.getDepth());
      this.wrapperTag = thisWrapperTag;
      this.indentLevel -= 1;
      this.indent();
    } else {
      this.currentBlock += 1;
    }
    this.writeEndTag(block);
  }

  processBlocksAtDepth(depth: number) {
    let block = this.blocks[this.currentBlock];
    while (block && block.getDepth() === depth) {
      this.processBlock();
      block = this.blocks[this.currentBlock];
    }
    this.closeWrapperTag();
  }

  getNextBlock(): ContentBlock {
    return this.blocks[this.currentBlock + 1];
  }

  writeStartTag(block) {
    let tags = getTags(block.getType());

    let attrString;
    if (this.options.blockStyleFn) {
      let {attributes, style} = this.options.blockStyleFn(block) || {};
      // Normalize `className` -> `class`, etc.
      attributes = normalizeAttributes(attributes);
      if (style != null) {
        let styleAttr = styleToCSS(style);
        attributes = (attributes == null) ? {style: styleAttr} : {...attributes, style: styleAttr};
      }
      attrString = stringifyAttrs(attributes);
    } else {
      attrString = '';
    }

    for (let tag of tags) {
      this.output.push(`<${tag}${attrString}>`);
    }
  }

  writeEndTag(block) {
    let tags = getTags(block.getType());
    if (tags.length === 1) {
      this.output.push(`</${tags[0]}>\n`);
    } else {
      let output = [];
      for (let tag of tags) {
        output.unshift(`</${tag}>`);
      }
      this.output.push(output.join('') + '\n');
    }
  }

  openWrapperTag(wrapperTag: string) {
    this.wrapperTag = wrapperTag;
    this.indent();
    this.output.push(`<${wrapperTag}>\n`);
    this.indentLevel += 1;
  }

  closeWrapperTag() {
    let {wrapperTag} = this;
    if (wrapperTag) {
      this.indentLevel -= 1;
      this.indent();
      this.output.push(`</${wrapperTag}>\n`);
      this.wrapperTag = null;
    }
  }

  indent() {
    this.output.push(INDENT.repeat(this.indentLevel));
  }

  renderBlockContent(block: ContentBlock): string {
    let blockType = block.getType();
    let text = block.getText();
    if (text === '') {
      // Prevent element collapse if completely empty.
      return BREAK;
    }
    text = this.preserveWhitespace(text);
    let charMetaList: CharacterMetaList = block.getCharacterList();
    let entityPieces = getEntityRanges(text, charMetaList);
    return entityPieces.map(([entityKey, stylePieces]) => {
      let content = stylePieces.map(([text, styleSet]) => {
        let content = encodeContent(text);
        for (let styleName of this.styleOrder) {
          // If our block type is CODE then don't wrap inline code elements.
          if (styleName === CODE && blockType === BLOCK_TYPE.CODE) {
            continue;
          }
          if (styleSet.has(styleName)) {
            let {element, attributes, style} = this.inlineStyles[styleName];
            if (element == null) {
              element = 'span';
            }
            // Normalize `className` -> `class`, etc.
            attributes = normalizeAttributes(attributes);
            if (style != null) {
              let styleAttr = styleToCSS(style);
              attributes = (attributes == null) ? {style: styleAttr} : {...attributes, style: styleAttr};
            }
            let attrString = stringifyAttrs(attributes);
            content = `<${element}${attrString}>${content}</${element}>`;
          }
        }
        return content;
      }).join('');
      let entity = entityKey ? this.entityGetter(entityKey) : null
      // Note: The `toUpperCase` below is for compatability with some libraries that use lower-case for image blocks.
      let entityType = (entity == null) ? null : entity.getType().toUpperCase();
      if(!(entityType !== null && this.entityFormatterMap.hasOwnProperty(entityType))){
        return content
      }

      let attrs = this.entityAttributesRendererMap.hasOwnProperty(entityType) ? this.entityAttributesRendererMap[entityType](entityType, entity)
          : this.entityAttributesRendererMap.DEFAULT(entityType, entity);

      return this.entityFormatterMap.hasOwnProperty(entityType) ? this.entityFormatterMap[entityType](content, stringifyAttrs(attrs), entity.getData())
          : this.entityFormatterMap.DEFAULT(content, stringifyAttrs(attrs), entity.getData());

    }).join('');
  }

  preserveWhitespace(text: string): string {
    let length = text.length;
    // Prevent leading/trailing/consecutive whitespace collapse.
    let newText = new Array(length);
    for (let i = 0; i < length; i++) {
      if (
        text[i] === ' ' &&
        (i === 0 || i === length - 1 || text[i - 1] === ' ')
      ) {
        newText[i] = '\xA0';
      } else {
        newText[i] = text[i];
      }
    }
    return newText.join('');
  }

}

function stringifyAttrs(attrs: ?Attributes) {
  if (attrs == null) {
    return '';
  }
  let parts = [];
  for (let name of Object.keys(attrs)) {
    let value = attrs[name];
    if (value != null) {
      parts.push(` ${name}="${encodeAttr(value + '')}"`);
    }
  }
  return parts.join('');
}

function canHaveDepth(blockType: string): boolean {
  switch (blockType) {
    case BLOCK_TYPE.UNORDERED_LIST_ITEM:
    case BLOCK_TYPE.ORDERED_LIST_ITEM:
      return true;
    default:
      return false;
  }
}

function encodeContent(text: string): string {
  return text
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('\xA0').join('&nbsp;')
    .split('\n').join(BREAK + '\n');
}

function encodeAttr(text: string): string {
  return text
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

export default function stateToHTML(content: ContentState, options: ?Options): string {
  return new MarkupGenerator(content, options).generate();
}
