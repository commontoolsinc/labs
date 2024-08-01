use js_sys::Math::random;
use leptos::*;

#[component]
pub fn ToggleContent(children: Children) -> impl IntoView {
    let toggle_id = random();
    let input_id = format!("toggle-{}", toggle_id);

    view! {
        <div class="toggle-container">
            <input type="checkbox" id={&input_id} class="toggle-input" />
            <label for={&input_id} class="toggle-label"></label>
            <div class="toggle-content">
                {children()}
            </div>
        </div>
    }
}
