import os
import uuid
import sys
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

def on_connect(client, _userdata, _flags, rc):
    if rc == 0:
        print("✅ Connected to MQTT broker", flush=True)
        client.subscribe("BeanNian/esp32/#")
    else:
        print(f"❌ MQTT connect failed: {rc}", flush=True)

def on_message(client, _userdata, msg):
    message = msg.payload.decode()
    print(f"📩 [{msg.topic}]: {message}", flush=True)
    try:
        line_bot_api.push_message(USER_ID, TextSendMessage(text=f"[{msg.topic}]\n{message}"))
        print("✅ Sent to Line!", flush=True)
    except Exception as e:
        print(f"❌ Line push error: {e}", flush=True)

mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message

try:
    mqtt_client.connect("broker.hivemq.com", 1883, keepalive=60)
    mqtt_client.loop_start()
except Exception as e:
    print(f"❌ MQTT init error: {e}", flush=True)

@app.route("/", methods=["GET"])
def health():
    return "OK", 200

@app.route("/webhook", methods=["POST"])
def webhook():
    print("📬 Webhook received!", flush=True)
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    print(f"Body: {body}", flush=True)
    try:
        handler.handle(body, signature)
    except Exception as e:
        print(f"❌ Handler error: {e}", flush=True)
        return "Error", 400
    return "OK", 200

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    text = event.message.text
    print(f"💬 Message: {text}", flush=True)
    reply_text = None

    if text == "เปิด System":
        mqtt_client.publish("BeanNian/esp32/config", "system:ON")
        reply_text = "✅ เปิด System แล้ว"
    elif text == "ปิด System":
        mqtt_client.publish("BeanNian/esp32/config", "system:OFF")
        reply_text = "✅ ปิด System แล้ว"
    elif text == "เปิด Alert":
        mqtt_client.publish("BeanNian/esp32/config", "alert:ON")
        reply_text = "🔔 เปิด Alert แล้ว"
    elif text == "ปิด Alert":
        mqtt_client.publish("BeanNian/esp32/config", "alert:OFF")
        reply_text = "🔕 ปิด Alert แล้ว"
    elif text == "ROAM":
        mqtt_client.publish("BeanNian/esp32/config", "mode:ROAM")
        reply_text = "🤖 โหมด ROAM"
    elif text == "TRACK":
        mqtt_client.publish("BeanNian/esp32/config", "mode:TRACK")
        reply_text = "🎯 โหมด TRACK"
    elif text == "STATIC":
        mqtt_client.publish("BeanNian/esp32/config", "mode:STATIC")
        reply_text = "🛑 โหมด STATIC"
    elif text.startswith("angle:"):
        # format: angle:0-180
        parts = text.split(":")[1].split("-")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            minVal, maxVal = int(parts[0]), int(parts[1])
            if 0 <= minVal < maxVal <= 180:
                mqtt_client.publish("BeanNian/esp32/config", text)
                reply_text = f"📐 กวาด {minVal}°-{maxVal}° (ROAM/TRACK)"
            else:
                reply_text = "❌ range ต้องอยู่ใน 0-180 และ min < max"
        else:
            reply_text = "❌ format ผิด ใช้ angle:45-135"
    elif text.startswith("pos:"):
        # format: pos:90
        parts = text.split(":")
        if len(parts) == 2 and parts[1].isdigit():
            deg = int(parts[1])
            if 0 <= deg <= 180:
                mqtt_client.publish("BeanNian/esp32/config", text)
                reply_text = f"📍 STATIC หมุนไปที่ {deg}°"
            else:
                reply_text = "❌ มุมต้องอยู่ใน 0-180"
        else:
            reply_text = "❌ format ผิด ใช้ pos:90"
    else:
        reply_text = f"❓ ไม่รู้จำคำสั่ง: {text}"
    

    if reply_text:
        print(f"↩️ Reply: {reply_text}", flush=True)
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=reply_text)
        )

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)