# Contact Form

This is an **end-to-end encrypted** kind of chat application that aims to give you a convenient method with which you can **offer your contact information** (in the form of a URL) to the public but still communicate anonymously while **maximizing privacy** for all involved parties.

It can be used as an **alternative to email** and to messaging apps that require you to reveal your phone number or other sensitive data.

This project builds on the principle of "**Can't be evil**".

"Contact Form" is the project's working title.


## Highlights

You can **host it yourself**, and you can easily **piggyback non-technical people** to make use of the Contact Form themselves and, by doing so, spread the use of private communication.

Completely **web-based** and **anonymous**: Access through browser with username/password.

The **username/password** combination makes a user's identity.
Users log in again to see your reply and to continue the conversation.

The front-end application **leaves no trace** on the device.
This is good in case your device ever gets compromised.
**No cookies** whatsoever are used, and neither keys nor messages are stored on the device.
The entire session lives **in-memory**.
Once the page is closed or refreshed, the session is **gone immediately**.

**Entry points**:
While the application uses a base URL, entry points complete the URL that you use as your own access point and those URLs that you pass to others to get in touch with you.
Each entry point is therefore its own URL.
Create as many entry points as you like and decide which entry point you reveal to whom.
Delete entry points to quickly **cut off spam** or unwanted visitors.
Kind of like email aliases or throw-away addresses.


## Features

### Embedding

Embed the Contact Form into your web page instead of e.g. an e-mail address.

Embedding works via `iframe`.
Point the `iframe` to the entry point you wish to direct communications to.
Use the query parameter `embedded=true` for embedded mode which hides not so important text.

```html
<iframe src="contact-form-instance.xyz/tenant/entry-point?embedded=true"></iframe>
```

> Tip: Create a dedicated entry point with a name that mentions the embedding site plus some random text.
> E.g.: `personal-site-9h8sdfh`
>
> The random text allows you to delete and recreate the entry point with a new random text but keep the `personal-site` part.
> This may be handy in case the entry point ever gets flooded with spam.


### Styling when embedding

When embedding the Contact Form into your website, you might want to customize some styling to make it better fit in with your page's appearance.

Use query parameter `style`.
Styles will be applied to `body` of the embedded application.
Separate them with `;`.

Note that URL length is limited and leaves room for only a few style rules.

```html
<iframe src="contact-form-instance.xyz/tenant/entry-point?embedded=true&style=background-color:lightblue;font-family:serif"></iframe>
```
