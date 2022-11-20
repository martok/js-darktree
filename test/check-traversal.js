(function () {
  "use strict";


  function assertEq(expected, value, message) {
    if (expected !== value) {
      console.warn("Failed: ", message, "\nExpected:", expected, " got: ", value);
    }
  }

  function printNode(aNode, aTarget) {
    const doc = aTarget.ownerDocument;

    const item = doc.createElement("div");
    item.className = "node";
    aTarget.appendChild(item);

    switch(aNode.nodeType) {
      case Node.ELEMENT_NODE:
        item.classList.add("element");
        item.innerHTML = `<span class="tagName">${aNode.localName}<span/>`;
        for (const attr of aNode.attributes) {
          const span = doc.createElement("span");
          span.className = "attribute";
          span.innerHTML = `<span class="attrName"></span>=<span class="attrValue"></span>`;
          span.firstChild.textContent = attr.name;
          span.lastChild.textContent = attr.value;
          item.firstChild.appendChild(span);
        }
        break;
      case Node.TEXT_NODE:
        item.classList.add("text");
        let text = aNode.textContent;
        if (aNode.parentNode.localName == "style") {
          text = aNode.parentNode.textContent;
        }
        if (/^\s+$/.test(text)) {
          text = text.replaceAll("\n", "\u00b6").replaceAll(" ", "\u00b7");
        }
        item.textContent = text;
        break;
      case Node.DOCUMENT_FRAGMENT_NODE:
        item.classList.add("document");
        item.textContent = aNode.host ? "#shadow-root" : aNode.nodeName;
        break;
      case Node.COMMENT_NODE:
        item.classList.add("comment");
        item.textContent = aNode.textContent;
        break;
      default:
        item.textContent = aNode.nodeName;
    }

    const childList = doc.createElement("ul");

    if (aNode.dtShadowRoot) {
      assertEq(null, aNode.dtShadowRoot.parentNode, "ShadowRoot has no parent");

      const item = doc.createElement("li");
      childList.appendChild(item);
      printNode(aNode.dtShadowRoot, item);
    }

    let child = aNode.firstChild;
    let childCount = 0;
    if (child)
      assertEq(null, child.previousSibling, "First Child has no previous sibling");

    while (child) {
      assertEq(aNode, child.parentNode, "Child has self as parentNode");
      assertEq(child, aNode.childNodes[childCount], "Child iteration and array have same content");

      childCount++;

      const item = doc.createElement("li");
      childList.appendChild(item);
      printNode(child, item);

      const next = child.nextSibling;
      if (next)
        assertEq(child, next.previousSibling, "Next Child has current child as previousSibling");
      child = next;
    }
    const list = aNode.childNodes;
    assertEq(childCount, list.length, "Child iteration and array length agree");
    if (childList.childElementCount>0) {
      aTarget.appendChild(childList);
    }
  }

  function checkTraversal(node) {
    const outputWindow = window.open("", "__DT_checkTraversal", "popup=yes,width=500,height=400");
    const outputDoc = outputWindow.document;
    outputDoc.open(); outputDoc.close();
    const head = outputDoc.head;
    const body = outputDoc.body;

    const style = outputDoc.createElement("style");
    style.textContent = `
      body {
        font-family: sans-serif;
        font-size: 10pt;
      }
      ul {
        padding-left: 1em;
        margin: 0;
      }

      ul li {
        list-style-type: none;
        border-left: 1px solid lightgray;
        padding-left: 5px;
      }

      .node:hover {
        background-color: lavender;
      }
      .node.text {
        white-space: pre-line;
      }
      .node.document {
        color: green;
      }
      .node.comment {
        color: gray;
        font-style: italic;
      }
      .node.comment::before {
        content: "<!-- ";
      }
      .node.comment::after {
        content: "-->";
      }
      .tagName {
        color: blue;
      }
      .tagName::before {
        content: "<";
        color: #000;
      }
      .tagName::after {
        content: ">";
        color: #000;
      }
      .tagName .attrName {
        color:#dc4866;
      }
      .tagName .attrName::before {
        content: " ";
      }
      .tagName .attrValue {
        color:#48b1dc;
      }
      .tagName .attrValue::before,
      .tagName .attrValue::after {
        content: '"';
        color: #000;
      }
    `;
    head.appendChild(style);

    const tree = outputDoc.createElement("div");
    body.appendChild(tree);
    printNode(node, tree);
  }

  window.__DT_checkTraversal = checkTraversal;
}())