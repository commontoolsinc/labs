script for gmail to synopsys

# Setup Credentials

You'll need to get an [oauth crednetials.json](https://developers.google.com/gmail/api/quickstart/nodejs#authorize_credentials_for_a_desktop_application) file from google cloud console and put it in this directory.

1. visit [google cloud console](https://console.cloud.google.com/apis/credentials)
2. create a new project (or select an existing one)
3. enable the gmail api (you may need to search for it)
4. create credentials and select desktop app 
- Create Credentials > OAuth client ID
- Application type > Desktop app
- After the credentials are created, click `Download JSON` and put it in this directory as `credentials.json`

# Running

The first time you run the script it will open a browser window prompting you to login and authorize access.  Afterwards credentials will be stored in a `token.json` file and you won't have to do this again (hopefully)

```
deno run --allow-net --allow-read --allow-write --allow-run gmail.ts [number of emails to import]
```
