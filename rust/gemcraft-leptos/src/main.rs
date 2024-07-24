use leptos::*;
use logging::log;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

fn main() {
    console_error_panic_hook::set_once();

    mount_to_body(|| view! { <App/> })
}

#[component]
fn App() -> impl IntoView {
    let (count, set_count) = create_signal(0);

    view! {
        <button
            on:click=move |_| {
                // on stable, this is set_count.set(3);
                set_count(3);
            }
        >
            "Click me: "
            // on stable, this is move || count.get();
            {move || count()}
        </button>
        <FormWithPreview />
    }
}

#[component]
pub fn FormWithPreview() -> impl IntoView {
    let (image_url, set_image_url) = create_signal(String::new());
    let (description, set_description) = create_signal(String::new());
    let (json_data, set_json_data) = create_signal(String::from("{}"));

    let generate_preview = create_action(move |_| {
        async move {
            // LLM URL:
            // window.location.protocol + "//" + window.location.host + "/api/v0/llm";
            let win = window();

            let mut opts = RequestInit::new();
            opts.method("POST");
            // set body as JSON string
            opts.body(Some(&JsValue::from_str(
                r#"{"action": "create", "message": "hello"}"#,
            )));
            opts.co

            let request = Request::new_with_str_and_init("http://localhost:8000", &opts).unwrap();

            let resp_value = JsFuture::from(win.fetch_with_request(&request))
                .await
                .expect("failed to fetch");
            let resp: Response = resp_value.dyn_into().unwrap();

            let json = JsFuture::from(resp.json().unwrap())
                .await
                .expect("failed to get response text");
        }
    });

    let on_submit = move |ev: web_sys::SubmitEvent| {
        ev.prevent_default();
        // Handle form submission here
        log!("Form submitted");
        log!("Description: {}", description.get());
        log!("JSON Data: {}", json_data.get());
    };

    view! {
        <form on:submit=on_submit class="max-w-2xl mx-auto p-4">
            <div class="mb-4">
                <label for="image-preview" class="block mb-2 font-bold">Image Preview</label>
                <img
                    src=move || image_url.get()
                    alt="Preview"
                    class="w-full h-64 object-cover mb-2 bg-gray-100"
                />
                <button
                    type="button"
                    on:click=move |_| generate_preview.dispatch(())
                    class="bg-blue-500 text-white px-4 py-2 rounded"
                >
                    "Generate Preview"
                </button>
            </div>

            <div class="mb-4">
                <label for="description" class="block mb-2 font-bold">Description</label>
                <textarea
                    id="description"
                    on:input=move |ev| {
                        set_description.set(event_target_value(&ev));
                    }
                    prop:value=description
                    class="w-full p-2 border rounded"
                    rows="4"
                ></textarea>
            </div>

            <div class="mb-4">
                <label for="json-editor" class="block mb-2 font-bold">JSON Editor</label>
                <textarea
                    id="json-editor"
                    on:input=move |ev| {
                        set_json_data.set(event_target_value(&ev));
                    }
                    prop:value=json_data
                    class="w-full p-2 border rounded font-mono"
                    rows="10"
                ></textarea>
            </div>

            <button
                type="submit"
                class="bg-green-500 text-white px-4 py-2 rounded"
            >
                "Submit"
            </button>
        </form>
    }
}

fn event_target_value(ev: &web_sys::Event) -> String {
    let target: web_sys::EventTarget = ev.target().unwrap();
    let target: web_sys::HtmlTextAreaElement = target.dyn_into().unwrap();
    target.value()
}
