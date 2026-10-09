const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RestHandler = require("../lib/handler/RestHandler");
const { CommandPool } = require("../lib/CommandPool");

// processMultipart() writes each uploaded file to `${request.tmpDir}/${part.filename}`.
// part.filename is entirely client-supplied (the multipart "filename" field), so a
// traversal payload like "../../../../tmp/x" must never be allowed to escape the
// per-request tmpDir and overwrite a file elsewhere on disk.

function handler() {
  return new RestHandler({}, null, new CommandPool());
}

function fakePart(fieldname, filename, content = "data") {
  return {
    type: "file",
    fieldname,
    filename,
    encoding: "7bit",
    mimetype: "application/octet-stream",
    toBuffer: async () => Buffer.from(content)
  };
}

function fakeRequest(tmpDir, parts) {
  return {
    tmpDir,
    parts: async function* () {
      for (const part of parts) yield part;
    }
  };
}

function fakeReply() {
  const reply = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return reply;
}

async function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aux4-api-test-"));
  const outsideFile = path.join(os.tmpdir(), `aux4-api-test-escape-${process.pid}-${Date.now()}`);
  try {
    return await fn(tmpDir, outsideFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
}

const traversalNames = [
  "../../etc/x",
  "..\\..\\x",
  "/tmp/x",
  "a/b.wav",
  "",
  "..",
  "a\0.txt"
];

for (const name of traversalNames) {
  test(`processMultipart keeps a file uploaded as ${JSON.stringify(name)} inside tmpDir`, async () => {
    await withTmpDir(async (tmpDir) => {
      const rh = handler();
      const request = fakeRequest(tmpDir, [fakePart("file", name)]);
      const reply = fakeReply();

      const body = await rh.processMultipart(request, reply);

      assert.equal(reply.statusCode, null, "a traversal filename must not cause an error response");
      assert.equal(body.file.length, 1);

      const resultPath = body.file[0].path;
      const resolvedTmpDir = path.resolve(tmpDir);
      const resolvedResult = path.resolve(resultPath);

      assert.ok(
        resolvedResult === resolvedTmpDir || resolvedResult.startsWith(resolvedTmpDir + path.sep),
        `expected ${resolvedResult} to stay inside ${resolvedTmpDir}`
      );
      assert.ok(fs.existsSync(resolvedResult), "the file must have been written somewhere inside tmpDir");

      // The original (unsanitized) client-supplied name is still exposed in the metadata.
      assert.equal(body.file[0].filename, name);
    });
  });
}

test("processMultipart does not let a traversal filename overwrite a file outside tmpDir", async () => {
  await withTmpDir(async (tmpDir, outsideFile) => {
    fs.writeFileSync(outsideFile, "untouched");

    const rh = handler();
    const relativeEscape = path.relative(tmpDir, outsideFile);
    const request = fakeRequest(tmpDir, [fakePart("file", relativeEscape, "attacker-controlled")]);
    const reply = fakeReply();

    await rh.processMultipart(request, reply);

    assert.equal(fs.readFileSync(outsideFile, "utf8"), "untouched", "file outside tmpDir must be untouched");
  });
});

test("processMultipart does not clobber two parts that sanitize to the same filename", async () => {
  await withTmpDir(async (tmpDir) => {
    const rh = handler();
    const request = fakeRequest(tmpDir, [
      fakePart("file", "../a.txt", "first"),
      fakePart("file", "a.txt", "second")
    ]);
    const reply = fakeReply();

    const body = await rh.processMultipart(request, reply);

    assert.equal(body.file.length, 2);
    const [first, second] = body.file;
    assert.notEqual(first.path, second.path, "two uploads must not land on the same path");
    assert.equal(fs.readFileSync(first.path, "utf8"), "first");
    assert.equal(fs.readFileSync(second.path, "utf8"), "second");
  });
});

test("processMultipart keeps a normal filename unchanged", async () => {
  await withTmpDir(async (tmpDir) => {
    const rh = handler();
    const request = fakeRequest(tmpDir, [fakePart("file", "report.pdf", "content")]);
    const reply = fakeReply();

    const body = await rh.processMultipart(request, reply);

    assert.equal(body.file[0].filename, "report.pdf");
    assert.equal(path.basename(body.file[0].path), "report.pdf");
    assert.equal(path.dirname(path.resolve(body.file[0].path)), path.resolve(tmpDir));
  });
});
