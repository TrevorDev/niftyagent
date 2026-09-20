# 🔥NiftyAgent 

#### The single file agent CLI that is easy to understand and extend

The aim of this project is to show that tools like claude or codex cli tools are not as complicated as you'd think. The current implementation is under 500 lines of NodeJS js code and has 0 nodejs dependencies so its hopefully somewhat readable

### Usage

The file currently uses [Nano-GPT](https://nano-gpt.com/r/qXBdP3HE) as the model provider, you can create an account / add credits and generate an api key to choose a model like Muse Spark, Deepseek or GPT 5.6

```bash
node niftyAgent.js YOUR_API_KEY MODEL_NAME
```

### Extend

* Want the cli to read AGENTS.md?
* Want to use a different llm provider (eg. claude api or openrouter)?
* Want to manage context differently?
* Want to change the system prompt?
* Want to add additional tools?

No problem, just ask the agent to update itself to add the features you want with a prompt like
```bash
> Update niftyAgent.js to read AGENTS.md and add it to context on startup
```

Since this project is a single file, it is also easy to copy/paste into webUI versions of claude/chatGPT and ask them to update it directly

### Safety Notes
* Out of the box the harness attempts to limit reading/writing files in the path the command was run in
* Extending the agent to allow bash command access can add extra risk
* As with all agent CLIs, letting models read/write files on your machine can be dangerous so it is recommended to run on a a dummy pc or within a container for added safety

### Legal Disclaimer

This project is provided "as is" and "as available" without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.In no event shall the authors, contributors, or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software. You use this software entirely at your own risk.

Built with ❤️ by the [NiftyKick](https://niftykick.com/) design team
