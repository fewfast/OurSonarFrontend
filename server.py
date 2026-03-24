import os
import paho.mqtt.client as mqtt
from linebot import LineBotApi
from linebot.models import TextSendMessage
from flask import Flask, request
from linebot import WebhookHandler
from linebot.models import MessageEvent, TextMessage

app = Flask(__name__)

LINE_TOKEN = os.environ.get("LINE_TOKEN")
LINE_SECRET = os.environ.get("LINE_SECRET")
USER_ID = os.environ.get("USER_ID")

line_bot_api = LineBotApi(LINE_TOKEN)
handler = WebhookHandler(LINE_SECRET)

mqtt_client = mqtt.Client()

def on_connect(client, userdata, flags, rc):
    print("Connected to MQTT broker")
    client.subscribe("BeanNian/esp32/data")

def on_message(client, userdata, msg):
    message = msg.payload.decode()
    print(f"Received: {message}")
    line_bot_api.push_message(USER_ID, TextSendMessage(text=message))
    print("Sent to Line!")

mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message
mqtt_client.connect("broker.hivemq.com", 1883)
mqtt_client.loop_start()

@app.route("/webhook", methods=["POST"])
def webhook():
    signature = request.headers["X-Line-Signature"]
    body = request.get_data(as_text=True)
    handler.handle(body, signature)
    return "OK"

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    text = event.message.text
    if text == "เปิด Servo":
        mqtt_client.publish("BeanNian/esp32/servo", "ON")
    elif text == "ปิด Servo":
        mqtt_client.publish("BeanNian/esp32/servo", "OFF")
    elif text == "เปิด Alert":
        mqtt_client.publish("BeanNian/esp32/alert", "ON")
    elif text == "ปิด Alert":
        mqtt_client.publish("BeanNian/esp32/alert", "OFF")
    elif text == "ROAM":
        mqtt_client.publish("BeanNian/esp32/sonar", "ROAM")
    elif text == "TRACK":
        mqtt_client.publish("BeanNian/esp32/sonar", "TRACK")
    elif text == "STATIC":
        mqtt_client.publish("BeanNian/esp32/sonar", "STATIC")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

LINE_TOKEN = os.environ.get("LINE_TOKEN")
LINE_SECRET = os.environ.get("LINE_SECRET")
USER_ID = os.environ.get("USER_ID")