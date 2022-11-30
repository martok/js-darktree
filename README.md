# DarkTree
DarkTree is a Shadow DOM polyfill, specifically targeting the DOM feature support present in UXP browsers such as Pale Moon.

## Usage

Just include the script file before using any ShadowDOM feature. CustomElements (probably via polyfill such as
[the polymer one](https://www.npmjs.com/package/@webcomponents/custom-elements) must be loaded beforehand:

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="https://unpkg.com/@webcomponents/custom-elements/custom-elements.min.js"></script>
    <script src="darktree.js"></script>
  </head>
```

A few internals are exposed on `window`:

-   `__DT_Native` contains the DOM original prototypes before Mixins were installed
-   `ShadowRoot`, the ShadowRoot class
-   `HTMLSlotElement`, the prototype for slot Elements (only applied to a slot element after it is rendered once)
-   `__DT_Property` some helpers for working with properties

## Quirks & Limitations

Installation of the mixins is delayed until the first call to attachShadow, so that DOM method performance is not
degraded until actually needed.

Many details are implemented different from the Shadow DOM spec, but with the intent of creating the same rendered result.

-   `MutationObservers` will see a transparent view of the DOM.
-   Event retargeting is not implemented.
-   Composing/slotting is synchronous, so there is a performance impact.
-   CSS rewriting including the `:host` pseudoelement *is* available, but the `:slotted` selector is not.
-   `Element.querySelectorAll` and `Element.querySelector` act on the composed DOM, which might look unexpected.
-   `Element.children` and `Node.childNodes` are Arrays if emulated and NodeList if the native functions are used.

