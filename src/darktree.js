(function () {
  "use strict";

  // do install checks first
  if (window.ShadowRoot || Element.prototype.attachShadow) {
    if (!(window.ShadowRoot && Element.prototype.attachShadow)) {
      throw new TypeError("DarkTree: ShadowRoot is partially implemented.");
    }
    // already standards compliant
    return;
  }

  if (Node.prototype.getRootNode) {
    // Ensure config dom.getRootNode.enabled is "false", or it would not work correctly
    throw new TypeError("DarkTree: NodePrototype.getRootNode is available, but ShadowDOM is not.");
  }

  if (!customElements || !customElements.define) {
    throw new TypeError("DarkTree: customElements registry not available.")
  }

  // save everything that will be changed later on

  const propgetset = (o, p) => {
    const { get, set } = Object.getOwnPropertyDescriptor(o, p);
    return { get, set };
  }

  const Native = {
    customElements: {
      define: customElements.define.bind(customElements),
    },
    Element: {
      after: Element.prototype.after,
      append: Element.prototype.append,
      before: Element.prototype.before,
      childElementCount: propgetset(Element.prototype, "childElementCount"),
      children: propgetset(Element.prototype, "children"),
      firstElementChild: propgetset(Element.prototype, "firstElementChild"),
      innerHTML: propgetset(Element.prototype, "innerHTML"),
      insertAdjacentElement: Element.prototype.insertAdjacentElement,
      insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
      insertAdjacentText: Element.prototype.insertAdjacentText,
      lastElementChild: propgetset(Element.prototype, "lastElementChild"),
      nextElementSibling: propgetset(Element.prototype, "nextElementSibling"),
      outerHTML: propgetset(Element.prototype, "outerHTML"),
      prepend: Element.prototype.prepend,
      previousElementSibling: propgetset(Element.prototype, "previousElementSibling"),
      querySelector: Element.prototype.querySelector,
      querySelectorAll: Element.prototype.querySelectorAll,
      remove: Element.prototype.remove,
    },
    HTMLStyleElement: {
    },
    Node: {
      appendChild: Node.prototype.appendChild,
      childNodes: propgetset(Node.prototype, "childNodes"),
      cloneNode: Node.prototype.cloneNode,
      firstChild: propgetset(Node.prototype, "firstChild"),
      hasChildNodes: Node.prototype.hasChildNodes,
      insertBefore: Node.prototype.insertBefore,
      lastChild: propgetset(Node.prototype, "lastChild"),
      nextSibling: propgetset(Node.prototype, "nextSibling"),
      parentNode: propgetset(Node.prototype, "parentNode"),
      previousSibling: propgetset(Node.prototype, "previousSibling"),
      removeChild: Node.prototype.removeChild,
      textContent: propgetset(Node.prototype, "textContent"),
    },
  };

  // Constants/Tokens

  const ATTR_ID = "shadow-host-id";
  const ATTR_SLOT_STATUS = "shadow-slot-status";

  // Declarations

  const allowedAttachElements = new Set(["article", "aside", "blockquote", "body", "div",
                                         "footer", "h1", "h2", "h3", "h4", "h5", "h6",
                                         "header", "main", "nav", "p", "section", "span"]);
  let hostElementID = 1;

  const NodeQ = new class NodeQ_ {
    getRoot(node) {
      // return the enclosing ShadowRoot or the Document if not in a shadow tree
      while (node.parentNode)
        node = node.parentNode;
      return node;
    }

    getShadowRoot(node) {
      // return the enclosing ShadowRoot or null if not in a shadow tree
      while (node.parentNode)
        node = node.parentNode;
      if (node instanceof ShadowRoot)
        return node;
      return null;
    }

    getShadowIncludingRoot(node) {
      let root = this.getRoot(node);
      while (node instanceof ShadowRoot)
        root = this.getRoot(root.host);
      return root;
    }

    isContainedIn(node, inside) {
      while (node.parentNode) {
        node = node.parentNode;
        if (node == inside)
          return true;
      }
      return false;
    }

    hasSameNativeChildren(node, children) {
      const current = Native.Node.childNodes.get.call(node);
      if (children.length !== current.length)
        return false;
      for (let i = 0; i<children.length; i++) {
        if (children[i] !== current[i]) {
          return false;
        }
      }
      return true;
    }

    getNodeSibling(node, direction) {
      const diff = direction>0 ? 1 : -1;
      const method = direction>0 ? Native.Node.nextSibling.get : Native.Node.previousSibling.get;

      let sibling = method.call(node);
      const dtParent = node.parentNode; //  may be a Node oder ShadowRoot

      if (dtParent) {
        // node is attached somewhere, is that place virtual? (this includes a shadow's host as well)
        if (dtParent.dtVirtualChildNodes) {
          // this will locate a node even if it is not currently in the live tree (ie. unslotted element)
          const idx = dtParent.dtVirtualChildNodes.findIndex(e => e === node);
          if (idx < 0)
            throw new DOMException("Node not found in VirtualParent children list", "HierarchyRequestError");
          const nidx = idx + diff;
          if (nidx >= 0 && nidx < dtParent.dtVirtualChildNodes.length)
            return dtParent.dtVirtualChildNodes[nidx];
          return null;
        } else {
          // not virtual
          if (dtParent instanceof ShadowRoot) {
            // inside the ShadowRoot, skip over nodes that belong to the host
            while (sibling && dtParent.host.dtVirtualChildNodes.includes(sibling)) {
              sibling = method.call(sibling);
            }
          }
        }
      }
      return sibling;
    }

    maybeTextNode(item) {
      if (item instanceof Node)
        return item;
      return document.createTextNode("" + item);
    }

    escapeAsInnerHTML(text) {
      // use an element that doesn't create child nodes but also doesn't do anything expensive after parsing
      const tmp = document.createElement("script");
      tmp.setAttribute("type", "application/x-not-parsed");
      Native.Node.textContent.set.call(tmp, text);
      return Native.Element.innerHTML.get.call(tmp);
    }

    tryNativeCloneNode(node, deep) {
      // CE polyfill patches cloneNode so that elements are constructed immediately,
      // real implementations delay that to DOM insertion.
      // Need the un-upgraded clone, so use an implementation detail
      // cf. https://github.com/webcomponents/polyfills/blob/master/packages/custom-elements/ts_src/Patch/Node.ts#L93
      const oldCE = node.ownerDocument.__CE_registry;
      try {
        delete node.ownerDocument.__CE_registry;
        return Native.Node.cloneNode.call(node, deep);
      } finally {
        node.ownerDocument.__CE_registry = oldCE;
      }
    }
  }

  const Property = new class Property_ {
    assignReadOnly(obj, name, value) {
      Object.defineProperty(obj, name, { value, configurable: true });
    }

    mixin(target, template) {
      for (const name of Object.getOwnPropertyNames(template)) {
        Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(template, name));
      }
    }

    mro(obj, prop) {
      if (!obj || obj == Object.prototype) {
        return [];
      }
      const inherited = Property.mro(Object.getPrototypeOf(obj), prop);
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      if (d) {
        d._at = obj;
        inherited.unshift(d);
      }
      return inherited;
    }
  }

  const Style = new class Style_ {
    constructor() {
      this.tempSheet = null;
    }

    parseCSS(source) {
      if (!this.tempSheet) {
        this.tempSheet = document.createElement("style");
        Native.Node.appendChild.call(document.head, this.tempSheet);
      }
      Native.Node.textContent.set.call(this.tempSheet, source);
      try {
        return this.tempSheet.sheet.cssRules;
      } finally {
        Native.Node.textContent.set.call(this.tempSheet, "");
      }
    }
  }

  // Mixins and exported classes

  class CERegistryMixin {
    define(name, cls) {
      allowedAttachElements.add(name);
      try {
        return Native.customElements.define.call(this, name, cls);
      } catch(c) {
          // rewrite JS exception classes from polyfill to correct DOMException
          if (c instanceof SyntaxError) {
            throw new DOMException(c.message, "SyntaxError");
          } else
          if (c instanceof Error && c.name==="Error") {
            throw new DOMException(c.message, "NotSupportedError");
          } else
            throw c;
      }
    }
  }

  class ElementMixin {
    attachShadow(init) {
      if (this.shadowRoot !== undefined)
        throw new DOMException(
            `The <${this.tagName}> element has be tried to attach to is already a shadow host.`,
            "InvalidStateError");
      if (!allowedAttachElements.has(this.localName))
        throw new DOMException(
            `The <${this.tagName}> element does not supported to attach shadow`,
            "NotSupportedError");
      // set up the virtual root
      let sr = new ShadowRoot();
      Property.assignReadOnly(sr, "host", this);
      Property.assignReadOnly(sr, "mode", init.mode);
      Property.assignReadOnly(sr, "delegatesFocus", !!init.delegatesFocus);
      sr.dtUnique = hostElementID++;
      Property.assignReadOnly(this, "shadowRoot", init.mode === "closed" ? null : sr);
      Property.assignReadOnly(this, "dtShadowRoot", sr);
      // Enable Mixin DOM traversal code!
      this.dtVirtualize();
      // give the ShadowRoot a new empty tree (rendering will reconstruct it from virtual)
      Native.Node.textContent.set.call(this, "")
      // nothing is slotted and the SR is empty - nothing to render
      return sr;
    }

    get assignedSlot() {
      const par = Native.Node.parentNode.get.call(this);
      if (par && par instanceof HTMLSlotElement) {
        return par;
      }
      return null;
    }
  }

  class ElementAccessMixin {
    // some of those don't exist on vanilla ShadowRoot (DocumentFragment)
    // instead of having another mixin, they just throw.

    after(...nodes) {
      const parent = this.parentNode;
      if (!parent)
        throw new DOMException("Node has no parent", "HierarchyRequestError");
      const ref = this.nextSibling;
      for (const node of nodes) {
        parent.insertBefore(NodeQ.maybeTextNode(node), ref);
      }
    }
    append(...nodes) {
      for (const node of nodes) {
        this.insertBefore(NodeQ.maybeTextNode(node), null);
      }
    }
    before(...nodes) {
      const parent = this.parentNode;
      if (!parent)
        throw new DOMException("Node has no parent", "HierarchyRequestError");
      for (const node of nodes) {
        parent.insertBefore(NodeQ.maybeTextNode(node), this);
      }
    }
    get childElementCount() {
      return this.children.length;
    }
    get children() {
      return Array.prototype.filter.call(this.childNodes, n => n instanceof Element);
    }
    get firstElementChild() {
      let child = this.firstChild;
      while(child && !(child instanceof Element))
        child = child.nextSibling;
      return child;
    }
    get innerHTML() {
      const parts = [];
      for (const node of this.childNodes) {
        switch (node.nodeType) {
          case Node.ELEMENT_NODE:
            parts.push(node.outerHTML);
            break;
          case Node.TEXT_NODE:
            parts.push(NodeQ.escapeAsInnerHTML(node.textContent));
            break;
          case Node.COMMENT_NODE:
            parts.push(`<!--${node.textContent}-->`);
        }
      }
      return parts.join("");
    }
    set innerHTML(text) {
      if (!this.dtVirtualChildNodes && !(this instanceof ShadowRoot)) {
        const result = Native.Element.innerHTML.set.call(this, text);
      }
      for (const node of this.childNodes) {
        this.removeChild(node);
      }
      this.insertAdjacentHTML("beforeend", text);
    }
    insertAdjacentElement(where, element) {
      if (!(element instanceof Element) &&
          !(element instanceof DocumentFragment) &&
          !(element instanceof Text))
        throw new DOMException("Argument 2 of Element.insertAdjacentElement does not implement interface Element.", "TypeError");

      const parent = this.parentNode;
      const outsideAllowed = parent && (parent !== this.ownerDocument);
      switch(where) {
        case "beforebegin": {
          if (!outsideAllowed)
            throw new DOMException("No valid parent", "NoModificationAllowedError");
          parent.insertBefore(element, this);
          break;
        }
        case "afterbegin": {
          this.insertBefore(element, this.firstChild);
          break;
        }
        case "beforeend": {
          this.insertBefore(element, null);
          break;
        }
        case "afterend": {
          if (!outsideAllowed)
            throw new DOMException("No valid parent", "NoModificationAllowedError");
          parent.insertBefore(element, this.nextSibling);
          break;
        }
        default:
          throw new DOMException("Invalid node location", "SyntaxError");
      }
    }
    insertAdjacentHTML(where, data) {
      const df = document.createElement("template");
      Native.Element.innerHTML.set.call(df, data);
      this.insertAdjacentElement(where, df.content);
    }
    insertAdjacentText(where, text) {
      this.insertAdjacentElement(where, document.createTextNode(""+text));
    }
    get lastElementChild() {
      let child = this.lastChild;
      while(child && !(child instanceof Element))
        child = child.previousSibling;
      return child;
    }
    get nextElementSibling() {
      if (!this.parentNode)
        throw new DOMException("Node has no parent", "HierarchyRequestError");
      let sibling = this.nextSibling;
      while(sibling && !(sibling instanceof Element))
        sibling = sibling.nextSibling;
      return sibling;
    }
    get outerHTML() {
      // can't use the cloneNode(false)-based method, as that would possibly spam attached shadows)
      const clone = NodeQ.tryNativeCloneNode(this, false);
      clone.removeAttribute(ATTR_ID);
      clone.removeAttribute(ATTR_SLOT_STATUS);
      const s = Native.Element.outerHTML.get.call(clone);
      let split = s.lastIndexOf("></");
      if (split < 0) split = s.length;
      return s.substr(0, split+1) + this.innerHTML + s.substr(split+1);
    }
    set outerHTML(text) {
      const parent = this.parentNode;
      if (!parent)
        throw new DOMException("Node has no parent", "NoModificationAllowedError");
      const ref = this.nextSibling;
      parent.removeChild(this);
      if (ref)
        ref.insertAdjacentHTML("beforebegin", text);
      else
        parent.insertAdjacentHTML("beforeend", text);
    }
    prepend(...nodes) {
      const ref = this.firstChild;
      for (const node of nodes) {
        this.insertBefore(NodeQ.maybeTextNode(node), ref);
      }
    }
    get previousElementSibling() {
      if (!this.parentNode)
        throw new DOMException("Node has no parent", "HierarchyRequestError");
      let sibling = this.previousSibling;
      while(sibling && !(sibling instanceof Element))
        sibling = sibling.previousSibling;
      return sibling;
    }
    querySelector(selector) {
      // TODO: implement
      return Native.Element.querySelector.call(this, selector);
    }
    querySelectorAll(selector) {
      // TODO: implement
      return Native.Element.querySelectorAll.call(this, selector);
    }
    remove() {
      const parent = this.parentNode;
      if (parent)
        parent.removeChild(this);
    }
  }

  const HTMLElementAccesMixin = {
    // Special casing for Polymer customElements
    insertAdjacentElement: ElementAccessMixin.prototype.insertAdjacentElement,
    insertAdjacentHTML: ElementAccessMixin.prototype.insertAdjacentHTML,
  };


  class HTMLSlotElement extends HTMLElement {
    constructor() {
      super();
    }

    get name() {
      return this.getAttribute("name") || "";
    }
    set name(val) {
      if (val !== name) {
        this.setAttribute("name", "val");
        ShadowRenderService.nodeUpdate(this);
      }
    }

    dtSlotAssign(children) {
      if (!children) {
        // put back placeholder elements
        children = this.dtVirtualChildNodes;
      }
      if (NodeQ.hasSameNativeChildren(this, children))
        return false;
      Native.Node.textContent.set.call(this, "");
      Native.Element.append.apply(this, children);
      // for some reason, setAttribute is *incredibly* slow on some sites (10ms+)
      // TODO: the attribute is not used currently, so don't set it at all
      // const a = "filled" : "open";
      // queueMicrotask(() => this.setAttribute(ATTR_SLOT_STATUS, a));
      return true;
    }
  }

  class HTMLStyleElementMixin {
    get textContent() {
      if (typeof this.dtOriginalTextContent !== "undefined")
        return this.dtOriginalTextContent;
      return Native.Node.textContent.get.call(this);
    }
    set textContent(text) {
      delete this.dtOriginalTextContent;
      ShadowRenderService.beginNodeUpdate(this);
      try {
        Native.Node.textContent.set.call(this, text);
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    get innerHTML() {
      if (typeof this.dtOriginalTextContent !== "undefined") {
        return NodeQ.escapeAsInnerHTML(this.dtOriginalTextContent);
      }
      return Native.Element.innerHTML.get.call(this);
    }
    set innerHTML(data) {
      delete this.dtOriginalTextContent;
      ShadowRenderService.beginNodeUpdate(this);
      try {
        Native.Element.innerHTML.set.call(this, data);
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    dtUpdateGlobalized() {
      if (typeof this.dtOriginalTextContent !== "undefined") {
        // not changed since last call to dtUpdateGlobalized
        return;
      }
      const sr = NodeQ.getShadowRoot(this);
      if (!sr) {
        return;
      }
      const selfSelector = sr.dtHostSelector;
      const source = this.textContent;
      // Save a copy of the original source before modifying
      this.dtOriginalTextContent = source;
      // 1. translate :host(-content) pseudoselector first, because it would be a parser error
      const rules = Style.parseCSS(source.replace(
                                    // flag "s" is broken in SeaMonkey
                                    /:host(-context)?(?:\(([\s\S]+?)\))?/g,
                                    function ($, context, selectors) {
                                      return !context ? !selectors ? selfSelector :
                                          `${selfSelector}:-moz-any(${selectors})` :
                                          `:-moz-any(${selectors}) ${selfSelector}`;
                                    }));
      // 2. prefix all rules that were not :host-relative already with the host child selector and transfer back to local style
      const newRules = [];
      for (const rule of rules) {
        const css = (rule instanceof CSSStyleRule) && !rule.selectorText.includes(selfSelector) ?
                    selfSelector + " " + rule.cssText :
                    rule.cssText;
        newRules.push(css);
      }
      // 3. assign modified sheet
      Native.Node.textContent.set.call(this, newRules.join("\n"));
    }
  }

  class NodeMixin {
    // Polyfill
    getRootNode(opt) {
      let composed = typeof opt === "object" && !!(opt.composed);
      return composed ? NodeQ.getShadowIncludingRoot(this) : NodeQ.getRoot(this);
    }

    get childNodes() {
      if (this.dtVirtualChildNodes) {
        return [... this.dtVirtualChildNodes];
      }
      return Native.Node.childNodes.get.call(this);
    }

    hasChildNodes() {
      if (this.dtVirtualChildNodes) {
        return !!this.dtVirtualChildNodes.length;
      }
      return Native.Node.hasChildNodes.call(this);
    }

    dtClearChildNodes() {
      ShadowRenderService.beginNodeUpdate(this);
      try {
        if (this.dtVirtualChildNodes) {
          for (const node of this.dtVirtualChildNodes) {
            const par = Native.Node.parentNode.get.call(node);
            if (par) {
              Native.Node.removeChild.call(par, node);
            }
            delete node.dtVirtualParent;
          }
          this.dtVirtualChildNodes.length = 0;
        } else {
          Native.Node.textContent.set.call(this, "");
        }
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    dtVirtualize() {
      if (this.dtVirtualChildNodes)
        throw new DOMException("Node is already virtual!", "InvalidStateError");
      Property.assignReadOnly(this, "dtVirtualChildNodes", [... Native.Node.childNodes.get.call(this)]);
      for (const node of this.dtVirtualChildNodes) {
        Property.assignReadOnly(node, "dtVirtualParent", this);
      }
    }

    get firstChild() {
      if (this.dtVirtualChildNodes) {
        if (this.dtVirtualChildNodes.length)
          return this.dtVirtualChildNodes[0];
        return null;
      }
      return Native.Node.firstChild.get.call(this);
    }

    get lastChild() {
      if (this.dtVirtualChildNodes) {
        if (this.dtVirtualChildNodes.length)
          return this.dtVirtualChildNodes.at(-1);
        return null;
      }
      return Native.Node.firstChild.get.call(this);
    }

    appendChild(child) {
      return this.insertBefore(child, null);
    }

    insertBefore(child, reference) {
      if (child && child.parentNode) {
        child.parentNode.removeChild(child);
      }
      ShadowRenderService.beginNodeUpdate(this, child);
      try {
        if (this.dtVirtualChildNodes) {
          const idx = reference ?
                        this.dtVirtualChildNodes.findIndex(e => e === reference) :
                        this.dtVirtualChildNodes.length;
          if (idx < 0)
            throw new DOMException("Node was not found", "NotFoundError");
          const insert = child instanceof DocumentFragment ? [... child.childNodes] : [child];
          Array.prototype.splice.apply(this.dtVirtualChildNodes, [idx, 0, ...insert]);
          for (const cn of insert) {
            Property.assignReadOnly(cn, "dtVirtualParent", this);
          }
          return child;
        }
        return Native.Node.insertBefore.call(this, child, reference);
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    removeChild(child) {
      ShadowRenderService.beginNodeUpdate(this, child);
      try {
        if (this.dtVirtualChildNodes && child) {
          const idx = this.dtVirtualChildNodes.findIndex((e) => e === child);
          if (idx < 0)
            throw new DOMException("Node was not found", "NotFoundError");
          this.dtVirtualChildNodes.splice(idx, 1);
          delete child.dtVirtualParent;
          return child;
        }
        return Native.Node.removeChild.call(this, child);
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    get parentNode() {
      if (this.dtVirtualParent)
        // fast case: explicit virtual parent
        return this.dtVirtualParent;
      const parent = Native.Node.parentNode.get.call(this);
      if (parent && parent.dtVirtualChildNodes) {
        // is the parent a shadow host and no virtual parent set? -> node is in dark tree, parent is ShadowRoot
        if (parent.dtShadowRoot)
          return parent.dtShadowRoot;
        // invalid state, dtVirtualParent should be set if parent.dtVirtualChildNodes is
        throw new DOMException("Virtual node hierarchy is in invalid state", "HierarchyRequestError");
      }
      // regular parent element
      return parent;
    }

    get nextSibling() {
      return NodeQ.getNodeSibling(this, 1);
    }

    get previousSibling() {
      return NodeQ.getNodeSibling(this, -1);
    }

    get textContent() {
      if (this.dtVirtualChildNodes) {
        const parts = [];
        for (const node of this.dtVirtualChildNodes) {
          parts.push(node.textContent);
        }
        return parts.join("");
      }
      return Native.Node.textContent.get.call(this);
    }
    set textContent(text) {
      if (this.textContent == text) {
        // computing the combined text is faster than a useless DOM update
        return;
      }
      ShadowRenderService.beginNodeUpdate(this);
      try {
        if (this.dtVirtualChildNodes) {
          this.dtClearChildNodes();
          const tn = document.createTextNode(text);
          this.appendChild(tn);
        } else {
          Native.Node.textContent.set.call(this, text);
        }
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    cloneNode(deep) {
      const result = Native.Node.cloneNode.call(this, false);
      // result may have gotten its shadowRoot initialized by the CE Polyfill, real shadow DOM would likely delay that
      if (deep) {
        for(const node of this.childNodes) {
          result.insertBefore(node.cloneNode(true), null);
        }
      }
      return result;
    }
  }

  /*
  A ShadowRoot must be re-rendered if:
    - attachShadow just happened
    - a child node enters/leaves its shadow tree (could be/contain a slot)
    - a child node enters/leaves its light tree (could be/contain slotted)
    - a slot's name or an elements slot attribute was changed

  Renders can be batched similar to CEReactions until "just before returning to user script".
  This is done by wrapping all complex DOM-updating entrypoints in beginUpdate/endUpdate pairs.
  To support reentrancy (mostly customElement constructors that cause updates to their own shadows), a stack
  is maintained that avoids nested updates.
  Update notifications that are not strict subsets of the current head are performed immediately.
  beginUpdate that is not a strict subset of the current head creates a new stack level
  beginUpdate that is a strict subset of the current head increments the nesting counter
  endUpdate always refers to the current head
  */

  const ShadowRenderService = new class ShadowRenderService_ {
    constructor() {
      this.updateStack = [];
      this.logPerfEnabled = false;
      this.logIndent = 0;
    }

    beginNodeUpdate(...nodes) {
      const affectedRoots = this.getRelatedShadowRootSet(nodes);
      if (this.isSubsetUpdate(affectedRoots)) {
        this.updateStack[0][1] = this.updateStack[0][1] + 1;
      } else {
        this.updateStack.unshift([affectedRoots, 1, nodes]);
      }
    }

    endNodeUpdate() {
      if (!this.updateStack.length) {
        throw new DOMException("ShadowRenderService nesting error", "NotSupportedError");
      }
      const newCount = this.updateStack[0][1] - 1;
      if (newCount > 0) {
        this.updateStack[0][1] = newCount;
        return;
      }
      const head = this.updateStack.shift();
      this.performShadowUpdates(head[0]);
    }

    nodeUpdate(nodeOrShadowRoot) {
      const sr = new Set(this.getRelatedShadowRootSet([nodeOrShadowRoot]));
      if (sr.size && !this.isSubsetUpdate(sr)) {
        this.performShadowUpdates(sr);
      }
    }

    isSubsetUpdate(rootset) {
      if (!this.updateStack.length)
        return false;
      const headset = this.updateStack[0][0];
      for (const root of rootset) {
        if (!headset.has(root)) {
          return false;
        }
      }
      return true;
    }

    getRelatedShadowRootSet(nodesOrShadows) {
      // a ShadowRoot is affected by a change on a node if it contains that node or is that node's shadow
      const result = new Set();
      for (const n of nodesOrShadows) {
        if (n instanceof ShadowRoot) {
          result.add(n);
        } else if (n.dtShadowRoot) {
          result.add(n.dtShadowRoot);
        } else {
          const sr = NodeQ.getShadowRoot(n);
          if (sr) {
            result.add(sr);
          }
        }
      }
      return result;
    }

    performShadowUpdates(updateRootSet) {
      if (!updateRootSet.size) {
        return;
      }
      this.logIndent++;
      const statStartTime = performance.now();
      let statCalcTime;
      let statStartRequests = updateRootSet.size;
      let statSlotAssignments = 0;
      let statSlotUnchanged = 0;
      let statSlotPreempted = 0;
      const slottingOrders = new Map();
      try {
        // compute
        for (const root of updateRootSet) {
          calculateSlottingFor(root, slottingOrders);
        }
        statCalcTime = performance.now();
        executeSlotting(slottingOrders);
      } finally {
        this.logIndent--;
        if (this.logPerfEnabled) {
          const statEndTime = performance.now();
          const calcMs = statCalcTime - statStartTime;
          const assignMs = statEndTime - statCalcTime;
          console.log("  ".repeat(this.logIndent),
                      `performShadowUpdates: ${calcMs}+${assignMs}ms, made ${statSlotAssignments} slot assignments (${statSlotUnchanged} unchanged), ${statSlotPreempted} preempted on ${statStartRequests}`,
                      Math.random());
        }
      }

      // implementation as hoisted functions that see the closure scope

      function slotAssignment(slot, children) {
        if (slottingOrders.has(slot)) {
          // same slot has two changes. this can happen if a node was moved between ShadowRoots
          statSlotPreempted++;
          executeSlotting();
        }
        slottingOrders.set(slot, children);
      }

      function calculateSlottingFor(root) {
        const selfHost = root.host;
        let slottables = [... selfHost.dtVirtualChildNodes];
        // note currently used slots
        const previousAssignedSlots = new Set();
        for (const n of slottables) {
          const slot = n.assignedSlot;
          if (slot)
            previousAssignedSlots.add(slot);
        }
        recursiveRender(root);
        // if a slot was not processed in this tree, it was moved outside. consider empty for now
        for (const slot of previousAssignedSlots) {
          slotAssignment(slot, null);
        }

        function recursiveRender(parent) {
          for (const node of parent.childNodes) {
            maybeUpgradeSlot(node);
            if (node instanceof HTMLSlotElement) {
              if (!slotFill(node)) {
                slotAssignment(node, null);
              }
              // mark slot as processed
              previousAssignedSlots.delete(node);
            } else if (node instanceof HTMLStyleElement) {
              node.dtUpdateGlobalized();
            } else {
              recursiveRender(node);
            }
          }
        }

        function maybeUpgradeSlot(node) {
          if (node.nodeType === Node.ELEMENT_NODE && node.localName === "slot" && !HTMLSlotElement.prototype.isPrototypeOf(node)) {
            Object.setPrototypeOf(node, HTMLSlotElement.prototype);
            // if we *just* did that, nothing can have been previously slotted. so, the current content is the fallback content
            node.dtVirtualize();
          }
        }

        function slotFill(slot) {
          const slotName = slot.name;
          const fnTest = slotName ?
                           // named slots accept all elements that have the corresponding slot name
                           (node) => node.nodeType === Node.ELEMENT_NODE && node.getAttribute("slot") === slotName :
                           // An unnamed <slot> will be filled with all of the custom element's top-level child nodes that do not have the slot attribute. This includes text nodes.
                           (node) => node.nodeType !== Node.ELEMENT_NODE || !node.hasAttribute("slot");
          const matched = slottables.filter((node) => fnTest(node));
          if (matched.length > 0) {
            slottables = slottables.filter((node) => !matched.includes(node));
            slotAssignment(slot, matched);
            return true;
          }
          return false;
        }
      }

      function executeSlotting() {
        for (const [slot, children] of slottingOrders) {
          if (!slot.dtSlotAssign(children)) {
            statSlotUnchanged++;
          }
          statSlotAssignments++;
        }
        slottingOrders.clear();
      }
    }
  }

  class ShadowRoot extends DocumentFragment {
    // host: Element
    // mode: str
    // delegatesFocus: bool

    get childNodes() {
      const children = Native.Node.childNodes.get.call(this.host);
      return Array.prototype.filter.call(children, n => !this.host.dtVirtualChildNodes.includes(n));
    }

    hasChildNodes() {
      return !!this.childNodes.length;
    }

    get firstChild() {
      let node = Native.Node.firstChild.get.call(this.host);
      while (node && this.host.dtVirtualChildNodes.includes(node)) {
        node = Native.Node.nextSibling.get.call(node);
      }
      return node;
    }

    get lastChild() {
      let node = Native.Node.lastChild.get.call(this.host);
      while (node && this.host.dtVirtualChildNodes.includes(node)) {
        node = Native.Node.previousSibling.get.call(node);
      }
      return node;
    }

    appendChild(child) {
      return this.insertBefore(child, null);
    }

    insertBefore(child, reference) {
      ShadowRenderService.beginNodeUpdate(this);
      try {
        return Native.Node.insertBefore.call(this.host, child, reference);
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    removeChild(child) {
      // remove from host, but check if it is ours first
      if (this.host.dtVirtualChildNodes.includes(child))
        throw new DOMException("Node was not found", "NotFoundError");
      const result = Native.Node.removeChild.call(this.host, child);
      ShadowRenderService.nodeUpdate(this);
      return result;
    }

    // inherit from DocumentFragment: parentNode, nextSibling, previousSibling

    get textContent() {
      const parts = [];
      for (const node of this.childNodes) {
        parts.push(node.textContent);
      }
      return parts.join("");
    }
    set textContent(text) {
      if (this.textContent == text) {
        // computing the combined text is faster than a useless DOM update
        return;
      }
      ShadowRenderService.beginNodeUpdate(this);
      try {
        for (const node of this.childNodes) {
          this.removeChild(node);
        }
        const tn = document.createTextNode(text);
        this.appendChild(tn);
      } finally {
        ShadowRenderService.endNodeUpdate();
      }
    }

    cloneNode(deep) {
      throw new DOMException("ShadowRoot nodes are not clonable.", "NotSupportedError");
    }

    get dtUnique() {
      return this.host.getAttribute(ATTR_ID);
    }
    set dtUnique(id) {
      this.host.setAttribute(ATTR_ID, id);
    }

    get dtHostSelector() {
      return `${this.host.localName}[${ATTR_ID}="${this.dtUnique}"]`;
    }
  }

  // installation

  function installExports() {
    window.__DT_Native = Native;
    window.__DT_Property = Property;
    window.ShadowRoot = ShadowRoot;
    window.HTMLSlotElement = HTMLSlotElement;
  }

  function installPatches() {
    Property.mixin(customElements, CERegistryMixin.prototype);
    Property.mixin(Element.prototype, ElementAccessMixin.prototype);
    Property.mixin(HTMLElement.prototype, HTMLElementAccesMixin);
    Property.mixin(ShadowRoot.prototype, ElementAccessMixin.prototype);
    delete ShadowRoot.prototype.outerHTML;
    Property.mixin(Element.prototype, ElementMixin.prototype);
    Property.mixin(HTMLStyleElement.prototype, HTMLStyleElementMixin.prototype);
    Property.mixin(Node.prototype, NodeMixin.prototype);
  }

  installExports();
  installPatches();
}())