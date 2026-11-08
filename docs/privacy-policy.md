# Dewee Chrome Extension privacy policy

Last updated: 1 November 2026

This policy covers the Dewee Chrome extension ("the extension"). The Dewee service you connect it to is covered by the
[Dewee privacy policy](https://dewee.sh/privacy).

## Summary

The extension is a client for your own Dewee account or Dewee Gateway. It sends data only to the Dewee server you
connect it to. It has no analytics, no telemetry, no advertising and no third-party trackers, and it does not sell or
share your data.

## What the extension handles and where it goes

| Data | When | Where it goes | Where it is kept in the browser |
|---|---|---|---|
| Connection profiles (server address, display name, theme, language) | When you add or change a profile | Nowhere | `chrome.storage.local` |
| Your credential: a personal Dewee Gateway API key, or Dewee Cloud sign-in tokens | When you connect | Only to that Dewee server, to authenticate requests | `chrome.storage.session` (cleared when the browser closes). Only if you turn on "Remember on this device" is it kept in `chrome.storage.local`. Never in `chrome.storage.sync`. |
| Chat messages you send and agent replies | When you chat | Your Dewee server | Not stored by the extension; history is loaded from the server |
| Values you type into a credential card (for example an API key an agent asks for) | When you submit the card | Only that card's answer endpoint on your Dewee server | Not stored; kept only in the form until it is sent |
| Text you select on a page, with that page's title and address ("Ask Dewee", off by default) | Only when you press Ask Dewee and then Send | Your Dewee server, as a chat message | A draft in `chrome.storage.session` until you send or discard it |
| Page content of tabs an agent operates ("connected browser", off by default) | Only for tabs the agent opened on sites you granted, or the one tab you shared, while the grant is valid | Your Dewee server, so the agent can read and act on the page | Device id, grants and pause state in `chrome.storage.local`; tab list in `chrome.storage.session` |

The connected browser never reads your other tabs. Password, payment and one-time-code field values are never read
out, and the agent cannot type into those fields. Actions that look like submit, publish, delete or payment ask you
first. You can pause, stop or revoke access in the side panel at any time.

## Permissions

- `sidePanel`: shows the extension in Chrome's side panel.
- `storage`: keeps the settings and data listed above.
- `identity`: opens the Dewee Cloud sign-in page.
- `alarms`: refreshes the pending-request badge and sign-in tokens in the background.
- `activeTab`: lets the side panel see the address of the tab in front when you open Dewee, so it can offer "Let the agent use this tab". Nothing is read until you press it.
- `scripting`: runs the extension's own bundled script, only in tabs an approved agent opened on sites you granted or the tab you shared, and
  for the optional Ask Dewee button. The extension does not run code it receives from the network.
- Site access is optional and asked for one site at a time: your Dewee server, the sites you grant to the connected
  browser, and all `https` sites only if you turn on Ask Dewee.

## Your choices

- Sign out or remove a profile in Settings to delete its credential from the browser.
- Turn Ask Dewee and the connected browser on or off in Settings and the side panel; revoke a site grant at any time.
- Remove the extension to delete everything it stored in the browser.
- To access or delete data held by the Dewee service, see the [Dewee privacy policy](https://dewee.sh/privacy).

## Limited use

The use of information received from Chrome APIs follows the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the
Limited Use requirements. Data is used only to provide the extension's features to you.

## Changes and contact

Changes to this policy are published in this file with a new date. Questions: hi@nextlevelbuilder.io or
[dewee.sh/contact](https://dewee.sh/contact).
