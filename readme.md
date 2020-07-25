# styletakeout.macro

Lets you pull CSS out of CSS-in-JS into an external CSS file. Similar to
`styled-components` and `csz` but at compile time instead of run time.

## TODO

- Implement +N filename counter and undo the shortest-filepath thing. Doesn't
  work with how Babel runs.

- Optimize cases that result in `${"css-cHelloMessage.tsx:18:28"}`

  I suppose this can be done _before_ the actual node/path replacement. If the
  parent is a template literal that has only one expression, then replace with
  the `t.stringLiteral(tag)`...

- Pretty @babel/codeframe error

## Options

TODO:

## Classnames

They're exported as `${prefix}${name}+${count}:${line}:${column}` where:

- **Prefix** defaults to `css-`. Listed in [options][1]

- **Name** is a filename (basename with extension) unless it's an _index_ file
  and [option "classUseFolder"][1] is true, then it's the folder name.

- **Count** is for conflict resolution as same-name files are encountered
  throughout the project. It increments from 0. This is an alternative to
  hashing, which _styled-components_ and friends often use.

  Note there was an attempt to use the shortest conflict-free file path but
  isn't possible due to a limtation from Babel; see [the appendix][2].

## Hiccups

You have to remember that this macro _removes_ the CSS source at compile time
in-place. This can be weird, even for experienced developers. It may be tempting
to write something like:

```ts
const textSizes = {
  'text-xs': '.75rem',
  'text-sm': '.875rem',
  ...
  'text-6xl': '4rem;',
};
for (const [k, v] of Object.entries(textSizes)) {
  styles[k] = css`font-size: ${v}`;
}
```

To save some typing, right? **Absolutely won't work**. This might be why most
CSS-in-JS are at runtime. Remember that the ``` css`` ``` function is replaced
entirely with the classname. This is the result:

```ts
for (const [k, v] of Object.entries(textSizes)) {
  styles[k] = "css-styles.ts:30:14";
}
```

When I have very repeatative styles like the above, or Tailwind-esque helper
rules like `m4` and `pb-2`, I put them in a static CSS file. Keeps it simple.

## Appendix

Explaining some quirks and design decisions:

### Babel CLI and patching `process.stdout.write`

This macro supports the `babel --watch` command to update the takeout on each
save in your editor. Unfortunately there's [no way to know when Babel is done
compiling][3] and files are processed one at a time in isolation. I managed to
get around this by adding a `process.on('exit', ...)` listener, since Babel
_must_ be done if the process is exiting. This works for any tools that are Node
processes like Webpack/Rollup, too. However, for `--watch` the process hangs
forever (that's the point)...there is a `console.log` message on each hot-update
though: "Successfully compiled N files with Babel (XXXms)". In Node the stdout
stream write-only, but the function `process.stdout.write` can be replaced - so
I wrapped it and look for _"Successfully compiled"_. You can change the string
with ["stdoutSearchString"][1] or turn off the patch with ["stdoutPatch"][1].

### Hash alternative: Shortest unique file path

I didn't want to use a hash or random number for the classname because in my
experience they're meaningless at a glance - `.sc-JwXcy` doesn't tell me
anything. The idea was to use the filename only, and if there was a collision,
reconcile by adjusting each of the conflicting names to use their parent
directory (as many times as needed).

For example, a conflicted `Grouper.jsx` component would have conflicts resolve
into `Dropdown/Grouper.jsx` and `List/Grouper.jsx`.

Originally I collected all filenames and did conflict resolution just before
writing the takeout (on process exit, likely). This didn't work. I imagine that
the AST had already been serialized by then, so changes weren't observed.

Next I tried to update on the fly - this work is at the HEAD of `unique-paths`
for reference - which _should_ work but I _think_ Babel must be serializing and
writing the AST for _each file as it's encountered_. Once the macro is working
on another file, references to the previous file's AST don't work. Ugh.

Even if it did work though, it adds a lot of code complexity. 1/3 of the code
was filepath reconcilation...

Settled on an auto-incrementing number `+N` since it _at least_ gives you the
filename at a glance, which is more meaningful than a hash. The mapping of N to
the full filepath is written alongside the CSS takeout for when you need to find
the source.

[1]: ##Options
[2]: ##Appendix
[3]: https://github.com/kentcdodds/babel-plugin-macros/issues/155
