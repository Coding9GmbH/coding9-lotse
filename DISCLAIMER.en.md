[Deutsch](DISCLAIMER.md) · **English**

# Disclaimer

Lotse is an open-source tool (MIT license) by CODING 9 GmbH. Please read these notes before connecting Lotse to a live shop.

## No warranty, use at your own risk
- Lotse is provided **"as is"**, without any assurance of fitness, freedom from errors or availability. The disclaimer of the [MIT license](LICENSE) applies.
- You use Lotse at your own risk. This applies especially to changes to a shop that generates revenue.
- The software is an early version (0.x). Features, settings and data formats may change without notice.

## AI results must be reviewed
- Language models make mistakes: wrong prices, invented product properties, unsuitable copy or broken page structures are possible.
- Lotse shows changes as a comparison or preview before writing. **The approval, and with it the review of the content, is up to you.**
- Legally relevant content (legal notice, privacy policy, right of withdrawal, warranties, delivery times, mandatory information, price information) must be checked by you or reviewed by a lawyer. The "shop check" is a technical check and **not legal advice**.

## Protecting your shop
- Test new workflows on a **staging shop** first.
- Back up the shop before larger changes. "Undo" in Lotse restores the values written by Lotse but does not replace a backup (e.g. not for changes you made to the same record outside Lotse).
- Use a dedicated integration with a restricted role instead of an admin user.
- The security mechanisms are described in [SECURITY.en.md](SECURITY.en.md). They reduce risks but cannot rule out misconfiguration or operating errors.

## Data protection and data transfer
- For the AI to work, shop content (e.g. product and page copy, categories, layouts, images you attach) is sent to the AI provider you chose (Anthropic or OpenAI). As the operator, you are responsible for this processing: you must arrange the data processing agreement, legal basis, information obligations and third-country transfers yourself.
- Customer, order, payment and credential data are blocked for the AI in Lotse. Still, do not enter them in the chat and do not attach documents containing personal data.
- Credentials are stored encrypted in the data volume. Protecting this volume, the server and an optional password is up to you.

## Costs
- Using the AI costs money with the respective provider (API usage or your subscription's limits). Large jobs can incur high costs. Set limits in your provider account.

## Trademarks, no affiliation with third parties
Shopware®, Shopify®, Magento®, Adobe Commerce®, OpenMage, Mage-OS, Claude®, Anthropic®, OpenAI®, ChatGPT® and Codex are trademarks or product names of their respective owners. Lotse is an independent project of CODING 9 GmbH and is not affiliated with these companies. It is neither supported nor endorsed by them.

## Third-party contributions and dependencies
Lotse uses open-source libraries and third-party services (including the Claude Agent SDK and the OpenAI Codex SDK) under their own licenses and terms of use. You are responsible for ensuring that your use of these services (e.g. with a subscription or API key) complies with their terms.

---
These notes are not legal advice. If you have questions about legally compliant use, please consult a lawyer. In case of doubt, the German version ([DISCLAIMER.md](DISCLAIMER.md)) prevails.
