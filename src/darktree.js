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
      this.css = null;
      this.tempSheet = null;
    }

    ensureInstalled() {
      if (this.css)
        return;

      this.css = document.createElement("style");
      Native.Node.textContent.set.call(this.css,`
        slot {
          display: contents;
        }
      `);
      Native.Node.appendChild.call(document.head, this.css);
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
      // ensure global CSS is installed
      Style.ensureInstalled();
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
      // force rendering once, which will at this point only detach unslotted bits from the tree
      sr.dtRenderSync();
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
        ShadowRoot.dtRenderIfInShadow(this);
      }
    }

    dtUnslot() {
      this.setAttribute(ATTR_SLOT_STATUS, "open");
      // remove all slotted elements, and put back placeholder elements
      // aka "realize" the dtVirtualChildNodes list
      Native.Node.textContent.set.call(this, "");
      for (const child of this.dtVirtualChildNodes) {
        Native.Node.appendChild.call(this, child);
      }
    }

    dtFillSlot(children) {
      if (!children.length)
        return;
      this.setAttribute(ATTR_SLOT_STATUS, "filled");
      // remove placeholder elements and add new children
      Native.Node.textContent.set.call(this, "");
      for (const child of children) {
        Native.Node.appendChild.call(this, child);
      }
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
      Native.Node.textContent.set.call(this, text);
      ShadowRoot.dtRenderIfInShadow(this);
    }

    get innerHTML() {
      if (typeof this.dtOriginalTextContent !== "undefined") {
        return NodeQ.escapeAsInnerHTML(this.dtOriginalTextContent);
      }
      return Native.Element.innerHTML.get.call(this);
    }
    set innerHTML(data) {
      delete this.dtOriginalTextContent;
      Native.Element.innerHTML.set.call(this, data);
      ShadowRoot.dtRenderIfInShadow(this);
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
      const source = this.textContent;
      // Save a copy of the original source before modifying
      this.dtOriginalTextContent = source;
      const selfSelector = sr.dtHostSelector;
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
      if (this.dtVirtualChildNodes) {
        for (const node of this.dtVirtualChildNodes) {
          const par = Native.Node.parentNode.get.call(node);
          if (par) {
            Native.Node.removeChild.call(par, node);
          }
          delete node.dtVirtualParent;
        }
        this.dtVirtualChildNodes.splice(0, this.dtVirtualChildNodes.length);
        if (this.dtShadowRoot)
          this.dtShadowRoot.dtRenderSync();
      } else {
        Native.Node.textContent.set.call(this, "");
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
      if (child)
        delete child.dtVirtualParent;
      if (this.dtVirtualChildNodes) {
        const idx = reference ?
                      this.dtVirtualChildNodes.findIndex(e => e === reference) :
                      this.dtVirtualChildNodes.length;
        if (idx < 0)
          throw new DOMException("Node was not found", "NotFoundError");
        const insert = child instanceof DocumentFragment ? [... child.childNodes] : [child];
        Array.prototype.splice.apply(this.dtVirtualChildNodes, [idx, 0, ...insert]);
        Property.assignReadOnly(child, "dtVirtualParent", this);
        if (this.dtShadowRoot) {
          // either slot it or set it aside
          this.dtShadowRoot.dtRenderSync();
        }
        return child;
      }
      return Native.Node.insertBefore.call(this, child, reference);
    }

    removeChild(child) {
      if (this.dtVirtualChildNodes && child) {
        const idx = this.dtVirtualChildNodes.findIndex((e) => e === child);
        if (idx < 0)
          throw new DOMException("Node was not found", "NotFoundError");
        this.dtVirtualChildNodes.splice(idx, 1);
        delete child.dtVirtualParent;
        if (this.dtShadowRoot)
          this.dtShadowRoot.dtRenderSync();
        return child;
      }
      const result = Native.Node.removeChild.call(this, child);
      ShadowRoot.dtRenderIfInShadow(this);
      return result;
    }

    get parentNode() {
      // i.e. for slotted element -> parent is the host
      if (this.dtVirtualParent)
        return this.dtVirtualParent;
      const parent = Native.Node.parentNode.get.call(this);
      if (parent && parent.dtVirtualChildNodes) {
        // parent has virtual children. is this one of them? -> "true" parent
        if (parent.dtVirtualChildNodes.includes(this))
          return parent;
        // no. is the parent a shadow host? -> node is in dark tree, parent is ShadowRoot
        if (parent.dtShadowRoot)
          return parent.dtShadowRoot;
        // no. this node is virtually detached
        return null;
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
      if (this.dtVirtualChildNodes) {
        this.dtClearChildNodes();
        const tn = document.createTextNode(text);
        this.appendChild(tn);
      } else {
        Native.Node.textContent.set.call(this, text);
        ShadowRoot.dtRenderIfInShadow(this);
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
      const result = Native.Node.insertBefore.call(this.host, child, reference);
      this.dtRenderSync();
      return result;
    }

    removeChild(child) {
      // remove from host, but check if it is ours first
      if (this.host.dtVirtualChildNodes.includes(child))
        throw new DOMException("Node was not found", "NotFoundError");
      const result = Native.Node.removeChild.call(this.host, child);
      this.dtRenderSync();
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
      for (const node of this.childNodes) {
        this.removeChild(node);
      }
      const tn = document.createTextNode(text);
      this.appendChild(tn);
      this.dtRenderSync();
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

    dtEnsureSlotClasses() {
      const allSlots = [];
      const recurse = (parent) => {
        let node = parent.firstChild;
        while (node) {
          // upgrade node if necessary
          if (node.nodeType === Node.ELEMENT_NODE && node.localName === "slot" && !HTMLSlotElement.prototype.isPrototypeOf(node)) {
            Object.setPrototypeOf(node, HTMLSlotElement.prototype);
            // if we *just* did that, nothing can have been previously slotted. so, the current content is the fallback content
            node.dtVirtualize();
          }
          if (node instanceof HTMLSlotElement) {
            allSlots.push(node);
          } else {
            recurse(node);
          }
          node = node.nextSibling;
        }
      }
      recurse(this);
      return allSlots;
    }

    dtRenderSync() {
      const selfHost = this.host;
      // prepare slots and slotted elements
      const allSlots = this.dtEnsureSlotClasses();
      let nodesToSlot = [... selfHost.dtVirtualChildNodes];
      // unslot everything
      const pastAndPresentSlots = new Set(allSlots);
      for (const n of nodesToSlot) {
        const slot = n.assignedSlot;
        if (slot)
          pastAndPresentSlots.add(slot);
      }
      for (const slot of pastAndPresentSlots) {
        slot.dtUnslot();
      }
      // go through the dark tree and assemble what we have
      recursiveRender(this);
      // any nodesToSlot that wasn't slotted remains detached

      function recursiveRender(parent) {
        let node = parent.firstChild;
        while (node) {
          if (node instanceof HTMLSlotElement) {
            slotFill(node);
          } else if (node instanceof HTMLStyleElement) {
            node.dtUpdateGlobalized();
          } else {
            recursiveRender(node);
          }
          node = node.nextSibling;
        }
      }

      function slotFill(slot) {
        const slotName = slot.name;
        const fnTest = slotName ?
                         // named slots accept all elements that have the corresponding slot name
                         (node) => node.nodeType == Node.ELEMENT_NODE && node.getAttribute("slot") === slotName :
                         // An unnamed <slot> will be filled with all of the custom element's top-level child nodes that do not have the slot attribute. This includes text nodes.
                         (node) => node.nodeType !== Node.ELEMENT_NODE || !node.hasAttribute("slot");
        const matched = nodesToSlot.filter((node) => fnTest(node));
        if (!!matched.length) {
          slot.dtFillSlot(matched);
          nodesToSlot = nodesToSlot.filter((node) => !matched.includes(node));
          return true;
        }
        return false;
      }
    }

    static dtRenderIfInShadow(node) {
      const sr = NodeQ.getShadowRoot(node);
      if (sr)
        sr.dtRenderSync();
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