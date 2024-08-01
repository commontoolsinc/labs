use std::rc::Rc;

use html::AnyElement;
use leptos::*;

#[derive(Clone)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub content: Rc<dyn Fn() -> HtmlElement<AnyElement>>,
}

#[component]
pub fn TabControl(tabs: Vec<Tab>, default_tab: String) -> impl IntoView {
    let tabs = create_rw_signal(tabs);
    let (active_tab, set_active_tab) = create_signal(default_tab);

    view! {
        <div class="tab-control">
            <div class="tab-header">
                <For
                    each=move || tabs.get()
                    key=|tab| tab.id.clone()
                    children=move |tab| {
                        let tab_id = tab.id.clone();
                        view! {
                            <button
                                class="tab-button"
                                class:active=move || active_tab() == tab_id
                                on:click=move |_| set_active_tab(tab.id.clone())
                            >
                                {tab.title.clone()}
                            </button>
                        }
                    }
                />
            </div>
            <div class="tab-content">
                <For
                    each=move || tabs.get()
                    key=|tab| tab.id.clone()
                    children=move |tab| {
                        let tab_id = tab.id.clone();
                        view! {
                            <div
                                class="tab-pane"
                                class:active=move || active_tab() == tab_id
                            >
                                {tab.content.clone()}
                            </div>
                        }
                    }
                />
            </div>
        </div>
    }
}