# Node.js Container Signing with Java Binding

[![Product Page](https://img.shields.io/badge/Product%20Page-2865E0?style=for-the-badge&logo=appveyor&logoColor=white)](https://github.com/groupdocs-signature/GroupDocs.Signature-Docs)
[![Docs](https://img.shields.io/badge/Docs-2865E0?style=for-the-badge&logo=Hugo&logoColor=white)](https://docs.groupdocs.com/signature/nodejs-java/)
[![Blog](https://img.shields.io/badge/Blog-2865E0?style=for-the-badge&logo=WordPress&logoColor=white)](https://blog.groupdocs.com/categories/groupdocs.signature-product-family/)
[![Free Support](https://img.shields.io/badge/Free%20Support-2865E0?style=for-the-badge&logo=Discourse&logoColor=white)](https://forum.groupdocs.com/c/signature/13)
[![Temporary License](https://img.shields.io/badge/Temporary%20License-2865E0?style=for-the-badge&logo=rocket&logoColor=white)](https://purchase.groupdocs.com/temp-license/107710)

## 🚀 Quick Start

`nodejs-docker-signing-with-fonts` is a runnable Node.js project that signs a PDF with Latin and CJK text signatures inside a Linux container and reports which fonts were usable. `npm install`, `npm start`, and the console prints a font report followed by the signing result. Two Dockerfiles ship with it so the fontless failure can be reproduced deliberately.

The binding is Node.js via Java: it loads a JVM in-process through node-java. That single fact drives most of what follows - the image needs a JDK as well as fonts, and several API shapes that look like plain JavaScript are actually Java calls in disguise.

## ✨ What You'll Learn

How to provision a Node image for a JVM-backed signing library, how to resolve a font family at run time instead of hard-coding one, why signatures here are applied one call at a time rather than as an array, and how to tell a binding limitation apart from an application bug.

### Which Node version should I use?

Node 18. The native bridge builds against NAN, which does not compile against the V8 in Node 20 and 22 - the failure reads `'AccessorSignature' is not a member of 'v8'`. Node 18 is the newest release that works and it is already end of life, so treat this container as pinned infrastructure rather than something to bump casually, and keep the image rebuild tied to a known-good base tag.

## 📖 About This Repository

This repository demonstrates container signing with GroupDocs.Signature for Node.js via Java. It applies two text signatures to `documents/sample.pdf`, inventories the fonts available, resolves a family by probing, and reports the read-back status. The audience is anyone deploying a Node signing service into a slim Linux image and finding that it behaves nothing like it did on a laptop.

`node:18-bookworm` ships 6 DejaVu font files for AWT. That is enough to sign Latin text and not enough for CJK, so the failure arrives with the first non-Latin document rather than at deployment.

## 🔑 Key Features

### GroupDocs.Signature Capabilities

| Feature | Description |
|---|---|
| **TextSignOptions** | text signature geometry plus an optional `SignatureFont` |
| **SignatureFont** | `setFamilyName` and `setSize`; naming an absent family raises |
| **sign(path, options)** | single-option overload, which is what marshals cleanly from JavaScript |
| **TextVerifyOptions** | the read-back API - unavailable through this binding, see below |
| **Font probing** | any family can be tested with a throwaway signature before it matters |

### What This Repository Demonstrates

Font inventory without a graphics toolkit, family resolution by probing, conditional font attachment, two-stage signing that works around a marshalling limit, and honest reporting when an API is not usable through the bridge.

## ⚙️ Prerequisites

Node 18 (see above), a JDK 17 in the image because node-java loads a JVM in process, plus the node-gyp toolchain (`build-essential`, `python3`) to build the bridge. `JAVA_HOME` and `LD_LIBRARY_PATH` both matter: node-java dlopens `libjvm.so` at run time and it is not on the default loader path. Fonts are a separate layer on top of all that.

Run on Java 8 through 17. GroupDocs.Signature for Java is Java-8 bytecode, and its imaging breaks on JDK 25 with `Cannot open an image. The image size can not be 0!`.

## 📁 Repository Structure

```
nodejs-docker-signing-with-fonts/
│
├── index.js
├── package.json
├── Dockerfile
├── Dockerfile.nofonts
├── .dockerignore
└── documents/
    └── sample.pdf
```

### File Overview

- **index.js** - the whole sample: inventory, probing, resolution, two-stage signing, verification
- **package.json** - pins `@groupdocs/groupdocs.signature` 24.12.0 and requires Node >= 18
- **Dockerfile** - JDK, node-gyp toolchain, JVM loader path, then fonts, then the app
- **Dockerfile.nofonts** - the same image with the font layer removed
- **documents/sample.pdf** - the input

## 💻 Implementation Examples

### Example 1: Returns the font files visible in the standard system and per-user font directories

The inventory runs first and uses `fs` directly, so it works identically on a laptop and in a slim image and needs no AWT toolkit.

```javascript
const home = os.homedir();
const roots = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  path.join(home, '.fonts'),
  path.join(home, '.local', 'share', 'fonts'),
  '/System/Library/Fonts',
  '/Library/Fonts',
];
if (process.env.WINDIR) {
  roots.push(path.join(process.env.WINDIR, 'Fonts'));
}
```

The recursive walk skips directories it cannot read rather than aborting:

```javascript
const walk = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A font directory we may not read tells us nothing; keep scanning the rest.
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (FONT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
};
```

A count of 6 on `node:18-bookworm` is the expected baseline, and every one of those is DejaVu.

### Example 2: Attempts a throwaway signature with one font family

The probe is a real signature into the temp directory, and the interesting part is the error handling. node-java reports only `Error running instance method`, so the actual GroupDocs message has to be dug out of the wrapped Java stack trace.

```javascript
const signature = new signatureLib.Signature(sourcePath);
const options = new signatureLib.TextSignOptions('probe');
options.setLeft(10);
options.setTop(10);
options.setWidth(60);
options.setHeight(20);
const font = new signatureLib.SignatureFont();
font.setFamilyName(familyName);
font.setSize(10);
options.setFont(font);
signature.sign(scratch, options);
return null;
```

```javascript
} catch (err) {
  // node-java reports only "Error running instance method"; the real GroupDocs text is in the
  // wrapped Java stack trace, so pull the exception line out of it.
  const stack = err.stack || '';
  const match = stack.match(/com\.groupdocs\.signature\.exception\.[^\n]*/);
  return match ? match[0].trim() : (err.message || String(err));
}
```

Without that regex, every font failure looks like the same generic bridge error, which makes diagnosing a container impossible from the logs alone.

### Example 3: Returns the first candidate family GroupDocs can actually use

Resolution walks an ordered candidate list and keeps the first family that does not raise.

```javascript
for (const candidate of candidates) {
  if (tryFamily(sourcePath, candidate) === null) {
    return candidate;
  }
}
return null;
```

`DejaVu Sans` resolves immediately in this image; the CJK list resolves only when `fonts-noto-cjk` is installed.

### Example 4: Builds a text signature option set, attaching a font only when a family was resolved

Geometry always, font conditionally. Note the Java-style setters - every one of these is a bridge call, not a property assignment.

```javascript
const options = new signatureLib.TextSignOptions(text);
options.setLeft(50);
options.setTop(top);
options.setWidth(280);
options.setHeight(40);
if (familyName) {
  const font = new signatureLib.SignatureFont();
  font.setFamilyName(familyName);
  font.setSize(16);
  options.setFont(font);
}
return options;
```

### Example 5: Signs the document with a text signature per resolved family

This is where the binding forces a different shape from the other platforms. The Java API exposes `sign(String, List)`, but a JavaScript array does not marshal to `java.util.List` through node-java, so the sample chains the single-option overload instead, staging through a temp file.

```javascript
const stageTwo = Boolean(cjkFamily);
const firstOutput = stageTwo
  ? path.join(os.tmpdir(), `gd-stage-${crypto.randomBytes(6).toString('hex')}.pdf`)
  : outputPath;

new signatureLib.Signature(sourcePath).sign(firstOutput, buildTextOptions(LATIN_TEXT, latinFamily, 50));
applied += 1;

if (stageTwo) {
  new signatureLib.Signature(firstOutput).sign(outputPath, buildTextOptions(CJK_TEXT, cjkFamily, 120));
  applied += 1;
  if (fs.existsSync(firstOutput)) {
    fs.unlinkSync(firstOutput);
  }
}
```

Passing an array produces `Could not find method "sign(java.lang.String, [Ljava.lang.Object;)"`. The two-stage version costs one extra file write and keeps the code in JavaScript rather than constructing Java collections by hand.

### Example 6: Verifies that the signed document carries a text signature matching the expected value

The verification path is written the way it should work, and then reports honestly when it does not.

```javascript
try {
  const signature = new signatureLib.Signature(signedPath);
  const options = new signatureLib.TextVerifyOptions(expectedText);
  options.setAllPages(true);
  const result = signature.verify(options);
  return sizeOf(result.getSucceeded());
} catch (err) {
  // The npm package is versioned 24.12.0 but bundles a 23.6.1 engine, and TextVerifyOptions does
  // not round-trip through this binding - verify raises "Error running instance method". Signing
  // is unaffected, so report the read-back as unavailable rather than failing the whole sample.
  return -1;
}
```

The `-1` is deliberate: it is neither zero matches nor a crash, and the console prints `unavailable (binding limitation - see README)` so nobody reads a working signature as a failed one. The npm package is versioned 24.12.0 and published in December 2024 while bundling a 23.6.1 engine, against .NET 26.6 and Java 26.5 - the read-back gap is a symptom of that lag.

## 📚 Related Resources

Explore these additional resources for container deployments of GroupDocs.Signature:

* **Step-by-step use case guide in the documentation** - The methods compared side by side, with the binding limits called out: [Read the article →](https://docs.groupdocs.com/signature/nodejs-java/use-cases/signing-documents-linux-container-fonts/)

* **In-depth blog article about this project** - What a JVM-in-process binding changes about containerising a Node service: [Read the article →](https://blog.groupdocs.com/signature/signing-documents-linux-container-fonts-nodejs-java/)

* **Installation** - Package name, supported Node versions and the native build requirements: [Read the article →](https://docs.groupdocs.com/signature/nodejs-java/installation/)

* **System requirements** - Supported platforms and JDK versions: [Read the article →](https://docs.groupdocs.com/signature/nodejs-java/system-requirements/)

## 🏷️ Keywords

`linux`, `sign`, `documents`, `pdf`, `docker`, `fonts`, `groupdocs signature`, `nodejs via java`, `node-java`, `text signature`, `container fonts`, `fontconfig`, `fonts-dejavu-core`, `fonts-noto-cjk`, `cjk signature`, `SignatureFont`, `TextSignOptions`, `node 18`, `openjdk-17`, `LD_LIBRARY_PATH`, `libjvm`, `font resolution`, `pdf signing linux`, `dockerfile`

---

**Need help?** [Get Free Support](https://forum.groupdocs.com/c/signature/13) | [Get Temporary License](https://purchase.groupdocs.com/temp-license/107710)
