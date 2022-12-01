# DarkTree
DarkTree is a Shadow DOM polyfill targeting the DOM support present in UXP browsers such as Pale Moon.

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


## Limitations

A lot, probably.
