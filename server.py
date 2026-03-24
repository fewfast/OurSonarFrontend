import os
import uuid
import paho.mqtt.client as mqtt
from linebot import LineBotApi, WebhookHandler
from linebot.models import TextSendMessage, MessageEvent, TextMessage
from flask import Flask, request

app = Flask(__name__)

LINE_TOKEN = os.environ.get("LINE_TOKEN")
LINE_SECRET = os.environ.get("LINE_SECRET")
USER_ID = os.environ.get("USER_ID")

line_bot_api = LineBotApi(LINE_TOKEN)
handler = WebhookHandler(LINE_SECRET)

mqtt_client = mqtt.Client(client_id=f"server-{uuid.uuid4()}")

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("✅ Connected to MQTT broker")
        client.subscribe("BeanNian/esp32/#")
    else:
        print(f"❌ MQTT connect failed: {rc}")

def on_message(client, userdata, msg):
    message = msg.payload.decode()
    print(f"📩 [{msg.topic}]: {message}")
    try:
        line_bot_api.push_message(USER_ID, TextSendMessage(text=f"[{msg.topic}]\n{message}"))
        print("✅ Sent to Line!")
    except Exception as e:
        print(f"❌ Line push error: {e}")

mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message

try:
    mqtt_client.connect("broker.hivemq.com", 1883, keepalive=60)
    mqtt_client.loop_start()
except Exception as e:
    print(f"❌ MQTT init error: {e}")

@app.route("/", methods=["GET"])
def health():
    return "OK", 200

@app.route("/webhook", methods=["POST"])
def webhook():
    print("📬 Webhook received!")
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except Exception as e:
        print(f"❌ Handler error: {e}")
        return "Error", 400
    return "OK", 200

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    text = event.message.text
    reply_text = None

    if text == "เปิด Servo":
        mqtt_client.publish("BeanNian/esp32/servo", "ON")
        reply_text = "✅ เปิด Servo แล้ว"
    elif text == "ปิด Servo":
        mqtt_client.publish("BeanNian/esp32/servo", "OFF")
        reply_text = "✅ ปิด Servo แล้ว"
    elif text == "เปิด Alert":
        mqtt_client.publish("BeanNian/esp32/alert", "ON")
        reply_text = "🔔 เปิด Alert แล้ว"
    elif text == "ปิด Alert":
        mqtt_client.publish("BeanNian/esp32/alert", "OFF")
        reply_text = "🔕 ปิด Alert แล้ว"
    elif text == "ROAM":
        mqtt_client.publish("BeanNian/esp32/sonar", "ROAM")
        reply_text = "🤖 โหมด ROAM"
    elif text == "TRACK":
        mqtt_client.publish("BeanNian/esp32/sonar", "TRACK")
        reply_text = "🎯 โหมด TRACK"
    elif text == "STATIC":
        mqtt_client.publish("BeanNian/esp32/sonar", "STATIC")
        reply_text = "🛑 โหมด STATIC"
    else:
        reply_text = f"❓ ไม่รู้จำคำสั่ง: {text}"

    if reply_text:
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=reply_text)
        )

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
