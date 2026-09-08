from openai import OpenAI

client = OpenAI(
    base_url='https://api.tokenrouter.com/v1',
    api_key='sk-ZD5v9AG7JxobXrvc8lV2OOzRBXKV4Zauq4iPMXwsbNtzCLaY',
)

messages = [
    {"role": "system", "content": "You are an intelligent assistant, please reply concisely."},
    {"role": "user", "content": "Hello, what kind of model are you?"},
]

stream = client.chat.completions.create(
    model="z-ai/glm-5.3-free",
    messages=messages,
    stream=True,
    stream_options={"include_usage": True},
    extra_body={}
)

content_parts = []
for chunk in stream:
    if chunk.choices:
        delta = chunk.choices[0].delta
        if delta and delta.content:
            content_parts.append(delta.content)

full_content = "".join(content_parts)

print(full_content)

