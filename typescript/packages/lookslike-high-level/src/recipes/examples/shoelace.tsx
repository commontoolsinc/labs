import { cell, handler, NAME, recipe, UI } from "@commontools/common-builder";
import { h } from "@commontools/common-html";

export const shoelaceDemo = recipe('click demo',
  ({ }) => {
    const onClick = handler<{}, { msg: string }>(({ }, { msg }) => {
      alert(msg)
    });

    return {
      [NAME]: "Shoelace Example",
      [UI]: <sl-card class="card-overview">
        <img
          slot="image"
          src="https://images.unsplash.com/photo-1559209172-0ff8f6d49ff7?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=crop&w=500&q=80"
          alt="A kitten sits patiently between a terracotta pot and decorative grasses."
        />

        <div slot="header">
          <sl-dropdown>
            <sl-button slot="trigger" caret>Dropdown</sl-button>
            <sl-menu>
              <sl-menu-item onclick={onClick({ msg: 'item 1' })}>Dropdown Item 1</sl-menu-item>
              <sl-menu-item onclick={onClick({ msg: 'item 2' })}>Dropdown Item 2</sl-menu-item>
              <sl-menu-item onclick={onClick({ msg: 'item 3' })}>Dropdown Item 3</sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item type="checkbox" checked>Checkbox</sl-menu-item>
              <sl-menu-item disabled>Disabled</sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item>
                Prefix
                <sl-icon slot="prefix" name="gift"></sl-icon>
              </sl-menu-item>
              <sl-menu-item>
                Suffix Icon
                <sl-icon slot="suffix" name="heart"></sl-icon>
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
        </div>

        <strong>Mittens</strong><br />
        This kitten is as cute as he is playful. Bring him home today!<br />
        <small>6 weeks old</small>

        <div slot="footer">
          <sl-button variant="primary" pill onclick={onClick({ msg: 'button' })}>Click me</sl-button>

        </div>
      </sl-card>
    }
  }
);
