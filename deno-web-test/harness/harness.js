const $ = document.querySelector.bind(document);
const formatError = (e) => ({
  name: e.name,
  message: e.message,
  stack: e.stack,
});

class Test {
  constructor(name, fn, el) {
    this.name = name;
    this.fn = fn;
    this.success = null;
    this.duration = null;
    this.error = null;
    this.el = el;
    this.el.innerText = name;
  }

  async run() {
    const start = performance.now();
    try {
      await this.fn();
      this.success = true;
      this.el.setAttribute("state", "success");
    } catch (e) {
      this.success = false;
      this.error = formatError(e);
      this.el.setAttribute("state", "error");
    }
    this.duration = performance.now() - start;
    // This matches `TestResult` in typescript
    return {
      name: this.name,
      error: this.error,
      duration: this.duration,
    };
  }
}

class TestController {
  constructor(harness) {
    this.harness = harness;
    this.globalError = null;
    globalThis.addEventListener("error", (e) => this.onGlobalError(e));
  }

  isReady() {
    if (this.globalError) {
      return { error: this.globalError };
    }
    const loadError = this.harness.getLoadError();
    if (loadError) {
      return { error: loadError.message };
    }
    return { ok: this.harness.ready() };
  }

  getTestCount() {
    return { ok: this.harness.tests.length };
  }

  async runNext() {
    return { ok: await this.harness.runNext() };
  }

  onGlobalError(e) {
    this.globalError = formatError(e);
  }
}

class TestHarness {
  constructor() {
    this.testFile = new URL(globalThis.location.href).searchParams.get("test");
    this.tests = [];
    this.currentTest = 0;
    this.loadError = null;
    this._ready = false;
  }

  ready() {
    return this._ready;
  }

  getLoadError() {
    return this.loadError;
  }

  async load() {
    $("#title").innerText = this.testFile;
    try {
      await import(`/dist${this.testFile}`);
    } catch (e) {
      this.loadError = e;
      return;
    }
    this._ready = true;
  }

  addTest(name, fn) {
    if (typeof name === "object" && name.name) {
      // Attempt to support BDD-style and Deno.test
      // objects with config, though not complete
      const object = name;
      name = object.name;
      fn = object.fn;
    }
    const el = document.createElement("li");
    $("#tests").appendChild(el);
    this.tests.push(new Test(name, fn, el));
  }

  async runNext() {
    const test = this.tests[this.currentTest++];
    if (!test) {
      // No more tests to run
      return null;
    }
    return await test.run();
  }
}

const harness = new TestHarness();
const controller = new TestController(harness);
globalThis.__denoWebTest = controller;

globalThis.Deno = Object.create(null);
globalThis.Deno.test = harness.addTest.bind(harness);
harness.load();
