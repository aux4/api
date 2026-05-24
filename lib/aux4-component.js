class Aux4Component extends HTMLElement {
  async connectedCallback() {
    const src = this.getAttribute("src");
    if (!src) return;

    const params = {};
    for (const attr of this.attributes) {
      if (attr.name !== "src") params[attr.name] = attr.value;
    }
    const query = new URLSearchParams(params).toString();
    const url = query ? `${src}?${query}` : src;

    const res = await fetch(url, { headers: { Accept: "text/html" } });
    if (res.ok) {
      this.innerHTML = await res.text();
    }
  }
}

customElements.define("aux4-component", Aux4Component);
