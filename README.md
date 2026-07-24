<h1 align="center">SlopTank</h1>
<h3 align="center">A community-built web client for personal media</h3>

---

<p align="center">
<img alt="SlopTank logo" src=".github/sloptank-mark.svg" width="160"/>
<br/>
<br/>
<a href="https://github.com/aaron13100/SlopTank/blob/master/LICENSE">
<img alt="GPL 2.0 License" src="https://img.shields.io/github/license/aaron13100/SlopTank.svg"/>
</a>
<a href="https://github.com/aaron13100/SlopTank/issues">
<img alt="Issues" src="https://img.shields.io/github/issues/aaron13100/SlopTank.svg"/>
</a>
</p>

SlopTank is a customized frontend for desktop browsers and compatible clients. Everyone is welcome
to contribute, including contributors using AI-assisted development tools.

SlopTank is an independent fork based on
[Jellyfin Web](https://github.com/jellyfin/jellyfin-web). It is not affiliated with, endorsed by,
or supported by the Jellyfin project. Jellyfin remains credited as the upstream project under the
terms of the repository's GPL-2.0 license.

## Build Process

### Dependencies

- [Node.js](https://nodejs.org/en/download)
- npm (included in Node.js)

### Getting Started

1. Clone or download this repository.

   ```sh
   git clone https://github.com/aaron13100/SlopTank.git
   cd SlopTank
   ```

2. Install build dependencies in the project directory.

   ```sh
   npm install
   ```

3. Run the web client with webpack for local development.

   ```sh
   npm start
   ```

4. Build the client with sourcemaps available.

   ```sh
   npm run build:development
   ```

## Directory Structure

> [!NOTE]
> We are in the process of refactoring to a [new structure](https://forum.jellyfin.org/t-proposed-update-to-the-structure-of-jellyfin-web) based on [Bulletproof React](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) architecture guidelines.
> Most new code should be organized under the appropriate app directory unless it is common/shared.

```
.
└── src
    ├── apps
    │   ├── dashboard           # Admin dashboard app
    │   ├── experimental        # New experimental app
    │   ├── stable              # Classic (stable) app
    │   └── wizard              # Startup wizard app
    ├── assets                  # Static assets
    ├── components              # Higher order visual components and React components
    ├── constants               # Common constant values
    ├── controllers             # Legacy page views and controllers 🧹 ❌
    ├── elements                # Basic webcomponents and React equivalents 🧹
    ├── hooks                   # Custom React hooks
    ├── lib                     # Reusable libraries
    │   ├── globalize           # Custom localization library
    │   ├── jellyfin-apiclient  # Supporting code for the deprecated apiclient package
    │   ├── legacy              # Polyfills for legacy browsers
    │   ├── navdrawer           # Navigation drawer library for classic layout
    │   └── scroller            # Content scrolling library
    ├── plugins                 # Client plugins (features dynamically loaded at runtime)
    ├── scripts                 # Random assortment of visual components and utilities 🐉 ❌
    ├── strings                 # Translation files (only commit changes to en-us.json)
    ├── styles                  # Common app Sass stylesheets
    ├── themes                  # Sass and MUI themes
    ├── types                   # Common TypeScript interfaces/types
    └── utils                   # Utility functions
```

- ❌ &mdash; Deprecated, do **not** create new files here
- 🧹 &mdash; Needs cleanup
- 🐉 &mdash; Serious mess (Here be dragons)
