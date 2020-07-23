import { createMacro } from 'babel-plugin-macros';
import * as t from '@babel/types';
import { stripIndent } from 'common-tags';
import { compile, serialize, stringify } from 'stylis';
import cssBeautify from 'cssbeautify';
import fs from 'fs';
import path from 'path';

import type { NodePath, PluginPass } from '@babel/core';
import type { MacroHandler } from 'babel-plugin-macros';

type ConfigOptions = {
  /** Prefix for all CSS classes: i.e `css-` will yield `css-index.tsx:32:16` */
  classPrefix: string,
  /** Relative path to output file. Defaults to `./build/takeout.css` */
  outputFile: string,
  // PR DefinitelyTyped#46190 - @types/cssbeautify didn't export 🙄
  /** Options for `cssbeautify` package or `false` to skip formatting */
  beautify: false | Parameters<typeof cssBeautify>[1],
  /** Log to the console */
  quiet: boolean,
  /** Support update-on-save by patching `process.stdout.write()` to know when Babel has compiled */
  stdoutPatch: boolean,
  /** String to look for with `indexOf()`. Defaults to @babel/cli's "Sucessfully compiled ..." */
  stdoutSearchString: string,
}

declare module 'babel-plugin-macros' {
  interface References {
    snip?: NodePath[]
    injectGlobal?: NodePath[]
    css?: NodePath[]
  }
  interface MacroParams {
    config: Partial<ConfigOptions>
  }
}

// Default config and then becomes resolved config at runtime
const opts: ConfigOptions = {
  classPrefix: 'css-',
  outputFile: 'build/takeout.css',
  beautify: {
    indent: '  ',
    openbrace: 'end-of-line',
    autosemicolon: true,
  },
  quiet: false,
  stdoutPatch: true,
  stdoutSearchString: 'Successfully compiled',
};

let updatesThisIteration = 0;
const snipBlocks = new Map<string, string>();
const injectGlobalBlocks = new Map<string, string>();
const cssBlocks = new Map<string, string>();

// Need to know when Babel is done compilation. Patch process.stdout to search
// for @babel/cli. If stdout never emits a sign of running in @babel/cli then
// process.exit will be used as a fallback; which is clearly after compilation.
let runningBabelCLI = false;
process.on('exit', () => !runningBabelCLI && writeStyles());

// Can't `process.stdout.on('data', ...` because it's a Writeable stream
const stdoutWrite = process.stdout.write;
// @ts-ignore Typescript can't wrap overloaded functions
process.stdout.write = (...args: Parameters<typeof process.stdout.write>) => {
  if (opts.stdoutPatch) {
    const [bufferString] = args;
    const string = bufferString.toString();
    if (string.startsWith(opts.stdoutSearchString)) {
      runningBabelCLI = true;
      // If this was `writeStyles()` and it threw an error, the stdout pipe
      // would be left broken so nothing would write; not even the error
      process.nextTick(writeStyles);
    }
  }
  return stdoutWrite.apply(process.stdout, args);
};

const mergeTemplateExpression = (node: t.Node): string => {
  if (!t.isTaggedTemplateExpression(node))
    throw new Error(`Macro can only be a tagged template. Found "${node.type}".`);

  let string = '';
  const { quasis, expressions } = node.quasi;
  for (let i = 0; i < expressions.length; i++) {
    const exp = expressions[i];

    if (!t.isIdentifier(exp))
      throw new Error('CSS can only reference "snip``" variables in ${} blocks.');

    if (!snipBlocks.has(exp.name))
      throw new Error(`\${${exp.name}} isn't defined.`);

    string += quasis[i].value.raw;
    string += snipBlocks.get(exp.name) as string;
  }
  // There's always one more `quasis` than `expressions`
  string += quasis[quasis.length - 1].value.raw;
  return stripIndent(string);
};

const sourceLocation = (node: t.Node, state: PluginPass) => {
  if (!node.loc) {
    throw new Error('Node didn\'t have location info as "node.loc"');
  }
  const { filename } = state;
  const { line, column } = node.loc.start;
  return `${path.basename(filename)}:${line}:${column}`;
};

const styletakeoutMacro: MacroHandler = ({ references, state, config }) => {
  Object.assign(opts, config);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  Object.assign(opts.beautify, config.beautify || {});

  const { snip, injectGlobal, css } = references;

  // Process snippets _first_ before they're used
  if (snip) snip.forEach(referencePath => {
    const { parentPath } = referencePath;
    const { node } = parentPath;
    if (!t.isVariableDeclarator(parentPath.parent)) {
      throw new Error('Macro snip`` can only be in the form "const/let/var x = snip`...`".');
    }
    // This variable name won't be unique for the entire codebase so rename it
    const parentId = parentPath.parent.id as t.Identifier;
    const id = parentPath.scope.generateUidIdentifierBasedOnNode(parentId);
    parentPath.scope.rename(parentId.name, id.name);

    const snippet = mergeTemplateExpression(node);
    snipBlocks.set(id.name, snippet);
    updatesThisIteration++;

    // Remove the entire VariableDeclarator
    parentPath.parentPath.remove();
  });

  if (injectGlobal) injectGlobal.forEach(referencePath => {
    const { parentPath } = referencePath;
    const { node } = parentPath;
    const loc = sourceLocation(node, state);
    const styles = mergeTemplateExpression(node);
    const stylesCompiled = serialize(compile(styles), stringify);
    const stylesPretty = opts.beautify === false
      ? stylesCompiled
      : cssBeautify(stylesCompiled, opts.beautify);

    injectGlobalBlocks.set(loc, `/* ${loc} */\n${stylesPretty}`);
    updatesThisIteration++;
    parentPath.remove();
  });

  if (css) css.forEach(referencePath => {
    const { parentPath } = referencePath;
    const { node } = parentPath;
    const loc = sourceLocation(node, state);
    const styles = mergeTemplateExpression(node);

    const tag = `${opts.classPrefix}${loc}`;
    const tagSafe = tag.replace(/([.:])/g, (_, match: string) => `\\${match}`);
    const stylesCompiled = serialize(compile(`.${tagSafe} { ${styles} }`), stringify);
    const stylesPretty = opts.beautify === false
      ? stylesCompiled
      : cssBeautify(stylesCompiled, opts.beautify);

    cssBlocks.set(loc, stylesPretty);
    updatesThisIteration++;
    parentPath.replaceWith(t.stringLiteral(tag));
  });
};

const toBlob = (x: Map<string, string>) => {
  let blob = '';
  // eslint-disable-next-line prefer-template
  for (const style of x.values()) blob += style + '\n';
  return blob;
};

let starting = true;
const writeStyles = () => {
  const updates = updatesThisIteration;
  const total = injectGlobalBlocks.size + cssBlocks.size;
  updatesThisIteration = 0;

  fs.writeFileSync(opts.outputFile, toBlob(injectGlobalBlocks));
  fs.appendFileSync(opts.outputFile, toBlob(cssBlocks));

  if (opts.quiet) return;

  if (starting) {
    console.log(`Moved ${total} CSS snippets to '${opts.outputFile}' with styletakeout.macro`);
    starting = false;
  } else {
    console.log(`Updated ${updates} of ${total} CSS snippets`);
  }
};

// export default createMacro(styletakeoutMacro);
export default createMacro(styletakeoutMacro, { configName: 'styletakeout' });
